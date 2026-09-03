import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  getAddress,
  http,
  verifyTypedData,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_EXECUTION_DOMAIN_NAME,
  executionTypedData,
  erc20Abi,
  privateLaunchpadAccountAbi,
  privateLaunchpadAccountFactoryAbi,
  type RelayExecutionRequest,
  type RelayerFee,
} from "@private-launchpad/sdk";
import { createPonsV2SemanticValidator } from "./pons-v2-policy.js";
import { relayReturnVerifierFromEnv } from "./relay-requests.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface RelayerPolicy {
  chainId: number;
  factory: Address;
  executionDomainName?: string;
  fee: RelayerFee;
  maxCalls: number;
  maxCalldataBytes: number;
  maxDeadlineSeconds: number;
  maxPrefund: bigint;
  allowedTargets?: ReadonlySet<string>;
  uniswapProxyApprovalTarget?: Address;
  semanticValidator?: SemanticCallValidator;
}

export type SemanticCallValidator = (
  request: RelayExecutionRequest,
  publicClient: PublicClient,
) => Promise<void>;

export interface RelayerDependencies {
  publicClient: PublicClient;
  walletClient: WalletClient;
  relayerAccount: ReturnType<typeof privateKeyToAccount>;
  sleep?: (milliseconds: number) => Promise<void>;
}

const EXECUTION_STATE_ATTEMPTS = 6;
const EXECUTION_STATE_RETRY_MS = 750;
const SIMULATION_ATTEMPTS = 4;
const SIMULATION_RETRY_BASE_MS = 500;

/** Conservative gas ceilings for one Robinhood policy-relayer transaction. */
export const RELAYER_FRESH_ACCOUNT_GAS_UNITS = 2_000_000n;
export const RELAYER_DEPLOYED_ACCOUNT_GAS_UNITS = 500_000n;

export interface RelayerGasReadiness {
  readonly readyForBroadcast: boolean;
  readonly gasBalance: bigint;
  readonly gasPrice: bigint;
  readonly minimumGasBalance: bigint;
  readonly minimumGasUnits: bigint;
}

export async function readRelayerGasReadiness(
  publicClient: PublicClient,
  relayerAddress: Address,
  accountDeployed = false,
): Promise<RelayerGasReadiness> {
  const [gasBalance, gasPrice] = await Promise.all([
    publicClient.getBalance({ address: relayerAddress }),
    publicClient.getGasPrice(),
  ]);
  const minimumGasUnits = accountDeployed
    ? RELAYER_DEPLOYED_ACCOUNT_GAS_UNITS
    : RELAYER_FRESH_ACCOUNT_GAS_UNITS;
  const minimumGasBalance = gasPrice * minimumGasUnits;
  return {
    readyForBroadcast: gasBalance >= minimumGasBalance,
    gasBalance,
    gasPrice,
    minimumGasBalance,
    minimumGasUnits,
  };
}

export function validateStaticPolicy(
  request: RelayExecutionRequest,
  policy: RelayerPolicy,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (request.chainId !== policy.chainId) throw new Error("wrong chain");
  if (getAddress(request.factory) !== getAddress(policy.factory))
    throw new Error("wrong factory");
  if (request.calls.length === 0 || request.calls.length > policy.maxCalls) {
    throw new Error("call count outside policy");
  }
  if (request.deadline < BigInt(nowSeconds)) throw new Error("request expired");
  if (request.deadline > BigInt(nowSeconds + policy.maxDeadlineSeconds)) {
    throw new Error("deadline exceeds policy");
  }
  if (request.prefund > policy.maxPrefund)
    throw new Error("prefund exceeds policy");
  if (
    getAddress(request.fee.token) !== getAddress(policy.fee.token) ||
    request.fee.amount !== policy.fee.amount ||
    getAddress(request.fee.recipient) !== getAddress(policy.fee.recipient)
  ) {
    throw new Error("fee does not match relayer policy");
  }
  let calldataBytes = 0;
  for (const call of request.calls) {
    calldataBytes += (call.data.length - 2) / 2;
    const target = getAddress(call.target).toLowerCase();
    if (target === ZERO_ADDRESS) throw new Error("zero call target");
    if (
      policy.allowedTargets &&
      !policy.allowedTargets.has(target) &&
      !isBoundedProxyApproval(call, policy.uniswapProxyApprovalTarget) &&
      !policy.semanticValidator
    ) {
      throw new Error(`target not allowed: ${call.target}`);
    }
  }
  if (calldataBytes > policy.maxCalldataBytes)
    throw new Error("calldata exceeds policy");
}

export class PrivateLaunchpadRelayer {
  constructor(
    readonly policy: RelayerPolicy,
    readonly dependencies: RelayerDependencies,
  ) {}

  async relay(request: RelayExecutionRequest): Promise<Hash> {
    validateStaticPolicy(request, this.policy);
    const { publicClient, walletClient, relayerAccount } = this.dependencies;
    const sleep = this.dependencies.sleep ?? delay;

    const predicted = await publicClient.readContract({
      address: this.policy.factory,
      abi: privateLaunchpadAccountFactoryAbi,
      functionName: "computeAddress",
      args: [request.owner, BigInt(request.accountIndex)],
    });
    if (getAddress(predicted) !== getAddress(request.account)) {
      throw new Error("account does not match factory owner/index derivation");
    }

    const signatureValid = await verifyTypedData({
      address: request.owner,
      ...executionTypedData({
        executionDomainName:
          this.policy.executionDomainName ?? DEFAULT_EXECUTION_DOMAIN_NAME,
        chainId: request.chainId,
        account: request.account,
        calls: request.calls,
        nonce: request.nonce,
        deadline: request.deadline,
        fee: request.fee,
        prefund: request.prefund,
      }),
      signature: request.signature,
    });
    if (!signatureValid) throw new Error("invalid owner signature");

    await this.policy.semanticValidator?.(request, publicClient);

    const code = await publicClient.getBytecode({ address: request.account });
    const accountDeployed = !!code && code !== "0x";
    const currentNonce = accountDeployed
      ? await publicClient.readContract({
          address: request.account,
          abi: privateLaunchpadAccountAbi,
          functionName: "nonce",
        })
      : 0n;
    if (currentNonce !== request.nonce) throw new Error("stale account nonce");

    const requiredTokenBalance = exactRequiredTokenBalance(request);
    if (!accountDeployed && requiredTokenBalance) {
      await waitForRequiredTokenBalance(
        publicClient,
        request.account,
        requiredTokenBalance,
        sleep,
      );
    }

    const gasReadiness = await readRelayerGasReadiness(
      publicClient,
      relayerAccount.address,
      accountDeployed,
    );
    if (!gasReadiness.readyForBroadcast) {
      throw new Error(
        `relayer gas account ${relayerAccount.address} has insufficient balance of Robinhood ETH: available ${gasReadiness.gasBalance} wei, required at least ${gasReadiness.minimumGasBalance} wei for ${gasReadiness.minimumGasUnits} gas at the current gas price`,
      );
    }

    const parameters = {
      account: relayerAccount,
      address: this.policy.factory,
      abi: privateLaunchpadAccountFactoryAbi,
      functionName: "deployAndExecute" as const,
      args: [
        request.owner,
        BigInt(request.accountIndex),
        [...request.calls],
        request.nonce,
        request.deadline,
        request.fee.token,
        request.fee.amount,
        request.fee.recipient,
        request.signature,
      ] as const,
      value: request.prefund,
    };
    const simulation = await simulateWithFreshStateRetry(
      () => publicClient.simulateContract(parameters),
      !accountDeployed && requiredTokenBalance !== undefined,
      sleep,
    );

    return walletClient.writeContract(simulation.request);
  }
}

interface RequiredTokenBalance {
  readonly token: Address;
  readonly amount: bigint;
}

function exactRequiredTokenBalance(
  request: RelayExecutionRequest,
): RequiredTokenBalance | undefined {
  const firstCall = request.calls[0];
  if (!firstCall || firstCall.value !== 0n) return undefined;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: firstCall.data });
    if (
      (decoded.functionName !== "approve" &&
        decoded.functionName !== "transfer") ||
      decoded.args[1] <= 0n
    ) {
      return undefined;
    }
    return { token: getAddress(firstCall.target), amount: decoded.args[1] };
  } catch {
    return undefined;
  }
}

async function waitForRequiredTokenBalance(
  publicClient: PublicClient,
  account: Address,
  spend: RequiredTokenBalance,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  let visibleBalance = 0n;
  let lastReadError: unknown;
  for (let attempt = 0; attempt < EXECUTION_STATE_ATTEMPTS; attempt += 1) {
    try {
      visibleBalance = await publicClient.readContract({
        address: spend.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      });
      lastReadError = undefined;
      if (visibleBalance >= spend.amount) return;
    } catch (error) {
      lastReadError = error;
    }
    if (attempt + 1 < EXECUTION_STATE_ATTEMPTS) {
      await sleep(EXECUTION_STATE_RETRY_MS);
    }
  }
  if (lastReadError) throw lastReadError;
  throw new Error(
    `execution account funding is not visible to the relayer yet: available ${visibleBalance}, required ${spend.amount}`,
  );
}

async function simulateWithFreshStateRetry<T>(
  simulate: () => Promise<T>,
  retryFreshState: boolean,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await simulate();
    } catch (error) {
      if (
        !retryFreshState ||
        attempt + 1 >= SIMULATION_ATTEMPTS ||
        !isRetryablePreBroadcastSimulation(error)
      ) {
        throw error;
      }
      await sleep(SIMULATION_RETRY_BASE_MS * 2 ** attempt);
    }
  }
}

function isRetryablePreBroadcastSimulation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /deployAndExecute.*revert|execution reverted|unknown reason|too many requests|\b429\b|rate[ -]?limit|\b50[234]\b|timed? ?out/i.test(
    message,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function relayerFromEnv(
  env: NodeJS.ProcessEnv,
): PrivateLaunchpadRelayer {
  const chainId = positiveInt(env.CHAIN_ID, "CHAIN_ID");
  const executionDomainName =
    env.EXECUTION_DOMAIN_NAME?.trim() || DEFAULT_EXECUTION_DOMAIN_NAME;
  const factory = requiredAddress(env.FACTORY_ADDRESS, "FACTORY_ADDRESS");
  const rpcUrl = required(env.RPC_URL, "RPC_URL");
  const privateKey = requiredHex(
    env.RELAYER_PRIVATE_KEY,
    "RELAYER_PRIVATE_KEY",
  );
  const relayerAccount = privateKeyToAccount(privateKey);
  const feeAmount = nonnegativeBigInt(
    env.RELAYER_FEE_AMOUNT ?? "0",
    "RELAYER_FEE_AMOUNT",
  );
  const feeToken =
    feeAmount === 0n
      ? ZERO_ADDRESS
      : requiredAddress(env.RELAYER_FEE_TOKEN, "RELAYER_FEE_TOKEN");
  const feeRecipient =
    feeAmount === 0n
      ? ZERO_ADDRESS
      : requiredAddress(
          env.RELAYER_FEE_RECIPIENT ?? relayerAccount.address,
          "RELAYER_FEE_RECIPIENT",
        );
  const allowedTargets = parseAllowedTargets(env.ALLOWED_TARGETS);
  const allowUnsafeAnyTargets = optionalBoolean(
    env.ALLOW_UNSAFE_ANY_TARGETS,
    "ALLOW_UNSAFE_ANY_TARGETS",
  );
  const allowUniswapProxyApprovals = optionalBoolean(
    env.ALLOW_UNISWAP_PROXY_APPROVALS,
    "ALLOW_UNISWAP_PROXY_APPROVALS",
  );
  const uniswapProxyApprovalTarget = allowUniswapProxyApprovals
    ? requiredAddress(env.UNISWAP_PROXY_ADDRESS, "UNISWAP_PROXY_ADDRESS")
    : undefined;
  const usePonsV2Policy = optionalBoolean(env.PONS_V2_POLICY, "PONS_V2_POLICY");
  const semanticValidator = usePonsV2Policy
    ? createPonsV2SemanticValidator(undefined, relayReturnVerifierFromEnv(env))
    : undefined;
  if (usePonsV2Policy && chainId !== 4663) {
    throw new Error("PONS_V2_POLICY requires Robinhood mainnet chain 4663");
  }
  if (!allowedTargets && !allowUnsafeAnyTargets && !semanticValidator) {
    throw new Error(
      "ALLOWED_TARGETS is required unless ALLOW_UNSAFE_ANY_TARGETS=true",
    );
  }
  // Keep the public and wallet transports distinct. Vercel's function
  // type-checker otherwise lets the wallet account generic bleed into the
  // public client when the same transport factory value is reused.
  const publicClient = createPublicClient({
    transport: http(rpcUrl),
  }) as unknown as PublicClient;
  const walletClient = createWalletClient({
    account: relayerAccount,
    transport: http(rpcUrl),
  });

  return new PrivateLaunchpadRelayer(
    {
      chainId,
      factory,
      executionDomainName,
      fee: { token: feeToken, amount: feeAmount, recipient: feeRecipient },
      maxCalls: positiveInt(env.MAX_CALLS ?? "16", "MAX_CALLS"),
      maxCalldataBytes: positiveInt(
        env.MAX_CALLDATA_BYTES ?? "65536",
        "MAX_CALLDATA_BYTES",
      ),
      maxDeadlineSeconds: positiveInt(
        env.MAX_DEADLINE_SECONDS ?? "900",
        "MAX_DEADLINE_SECONDS",
      ),
      maxPrefund: nonnegativeBigInt(
        env.MAX_PREFUND_WEI ?? "0",
        "MAX_PREFUND_WEI",
      ),
      ...(allowedTargets ? { allowedTargets } : {}),
      ...(uniswapProxyApprovalTarget ? { uniswapProxyApprovalTarget } : {}),
      ...(semanticValidator ? { semanticValidator } : {}),
    },
    { publicClient, walletClient, relayerAccount },
  );
}

function isBoundedProxyApproval(
  call: RelayExecutionRequest["calls"][number],
  proxy: Address | undefined,
): boolean {
  if (!proxy || call.value !== 0n) return false;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
    return (
      decoded.functionName === "approve" &&
      getAddress(decoded.args[0]) === getAddress(proxy)
    );
  } catch {
    return false;
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredAddress(value: string | undefined, name: string): Address {
  return getAddress(required(value, name));
}

function requiredHex(value: string | undefined, name: string): Hex {
  const result = required(value, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(result))
    throw new Error(`${name} must be a 32-byte hex key`);
  return result as Hex;
}

function positiveInt(value: string | undefined, name: string): number {
  const parsed = Number(required(value, name));
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonnegativeBigInt(value: string | undefined, name: string): bigint {
  const parsed = required(value, name);
  if (!/^(0|[1-9][0-9]*)$/.test(parsed)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return BigInt(parsed);
}

function optionalBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function parseAllowedTargets(
  value: string | undefined,
): ReadonlySet<string> | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return new Set(
    value
      .split(",")
      .map((target) =>
        requiredAddress(target.trim(), "ALLOWED_TARGETS").toLowerCase(),
      ),
  );
}
