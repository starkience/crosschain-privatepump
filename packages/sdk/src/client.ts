import {
  encodeFunctionData,
  getAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import {
  privateLaunchpadAccountAbi,
  privateLaunchpadAccountFactoryAbi,
  erc20Abi,
} from "./abi.js";
import { signExecution } from "./execution.js";
import {
  NO_RELAYER_FEE,
  type ExecuteOptions,
  type ExecutionConfirmation,
  type BridgeFundResult,
  type BridgeDepositResult,
  type BridgeDepositStepCallback,
  type BridgeCashOutResult,
  type BridgeCashOutStepCallback,
  type BridgeReturnResult,
  type BridgeBatchReturnResult,
  type BridgeStepCallback,
  type ExecutionCall,
  type LaunchpadAdapter,
  type PrivateLaunchpadClientConfig,
  type PrivateLaunchpadSession,
  type Eip1193Provider,
  type RelayExecutionRequest,
  type RelayerFee,
  type WalletBatchReturnResult,
  type WalletRecoveryAuthorization,
} from "./types.js";
import { walletRecoveryMessage } from "./wallet-recovery.js";

const DEFAULT_CHANNEL = "private-launchpad-v1";
const DEFAULT_DEADLINE_SECONDS = 10 * 60;
const RECOVERY_RPC_READ_ATTEMPTS = 4;
const RECOVERY_RPC_RETRY_BASE_MS = 500;

export class PrivateLaunchpadClient {
  readonly config: PrivateLaunchpadClientConfig;
  readonly channel: string;

  constructor(config: PrivateLaunchpadClientConfig) {
    if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) {
      throw new Error("chainId must be a positive safe integer");
    }
    this.config = config;
    this.channel = config.channel ?? DEFAULT_CHANNEL;
  }

  async deriveSession(
    signature: string,
    accountIndex: number,
  ): Promise<PrivateLaunchpadSession> {
    const derived = this.config.bridge.deriveEvmOwner(
      signature,
      accountIndex,
      this.channel,
    );
    const owner = derived.address as Address;
    const account = await this.config.publicClient.readContract({
      address: this.config.factory,
      abi: privateLaunchpadAccountFactoryAbi,
      functionName: "computeAddress",
      args: [owner, BigInt(accountIndex)],
    });
    return { accountIndex, channel: this.channel, owner, account };
  }

  async readPrivateBalance(signature: string): Promise<bigint> {
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
      throw new Error("identity signature must be hex");
    }
    return this.config.bridge.readPrivateBalance(signature);
  }

  /** Returns USDC already minted on Starknet but not yet deposited to STRK20. */
  async readPendingDeposit(signature: string): Promise<bigint> {
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
      throw new Error("identity signature must be hex");
    }
    return this.config.bridge.readPendingDeposit(signature);
  }

  /**
   * Deposits EVM USDC into the user's STRK20-backed private balance. The source
   * wallet and deposit amount remain public at the bridge edge; later position
   * withdrawals are unlinkable inside the pool.
   */
  async depositToPrivateBalance(args: {
    signature: string;
    amount: bigint;
    provider: Eip1193Provider;
    sourceChainId?: number;
    resume?: boolean;
    onStep?: BridgeDepositStepCallback;
    onBurned?: (info: { burnTxHash: string; explorerUrl?: string }) => void;
  }): Promise<BridgeDepositResult> {
    if (!/^0x[0-9a-fA-F]+$/.test(args.signature)) {
      throw new Error("identity signature must be hex");
    }
    if (args.amount <= 0n) throw new Error("deposit amount must be positive");
    if (this.config.depositTransport) {
      return this.config.depositTransport({
        bridge: this.config.bridge,
        signature: args.signature,
        amount: args.amount,
        provider: args.provider,
        resume: args.resume ?? false,
        ...(args.onStep ? { onStep: args.onStep } : {}),
        ...(args.onBurned ? { onBurned: args.onBurned } : {}),
      });
    }
    return this.config.bridge.moveIntoPool({
      signature: args.signature as Hex,
      funding: "metamask",
      amountWei: args.amount,
      provider: args.provider,
      sourceChainId: args.sourceChainId ?? this.config.chainId,
      ...(args.resume === undefined ? {} : { resume: args.resume }),
      ...(args.onStep === undefined ? {} : { onStep: args.onStep }),
      ...(args.onBurned === undefined ? {} : { onBurned: args.onBurned }),
    });
  }

  /** Withdraws private-balance USDC to a public EVM destination. */
  async withdrawPrivateBalance(args: {
    signature: string;
    amount: bigint;
    destination: Address;
    connectedEvmAddress: Address;
    onStep?: BridgeCashOutStepCallback;
  }): Promise<BridgeCashOutResult> {
    if (args.amount <= 0n) throw new Error("withdraw amount must be positive");
    return this.config.bridge.cashOut({
      resolveSignature: async () => args.signature,
      amount: args.amount,
      destination: args.destination,
      evmAddress: args.connectedEvmAddress,
      destChainId: this.config.chainId,
      ...(args.onStep === undefined ? {} : { onStep: args.onStep }),
    });
  }

  async fundSession(args: {
    signature: string;
    accountIndex: number;
    amount: bigint;
    connectedEvmAddress: Address;
    fast?: boolean;
    onStep?: BridgeStepCallback;
  }): Promise<BridgeFundResult> {
    const session = await this.deriveSession(args.signature, args.accountIndex);
    if (this.config.fundingTransport) {
      return this.config.fundingTransport({
        bridge: this.config.bridge,
        signature: args.signature,
        session,
        amount: args.amount,
        connectedEvmAddress: args.connectedEvmAddress,
        fast: args.fast ?? true,
        ...(args.onStep ? { onStep: args.onStep } : {}),
      });
    }
    return this.config.bridge.fundAccountFromPool({
      resolveSignature: async () => args.signature,
      accountIndex: args.accountIndex,
      amount: args.amount,
      evmAddress: args.connectedEvmAddress,
      resolveDepositWallet: async () => session.account,
      destChainId: this.config.chainId,
      channel: this.channel,
      ...(args.fast === undefined ? {} : { fast: args.fast }),
      ...(args.onStep === undefined ? {} : { onStep: args.onStep }),
    });
  }

  async open<TOpenIntent, TCloseIntent>(args: {
    signature: string;
    session: PrivateLaunchpadSession;
    adapter: LaunchpadAdapter<TOpenIntent, TCloseIntent>;
    intent: TOpenIntent;
    options?: ExecuteOptions;
  }): Promise<Hash> {
    this.assertAdapterChain(args.adapter);
    const calls = await args.adapter.buildOpenCalls(args.intent, {
      account: args.session.account,
      publicClient: this.config.publicClient,
    });
    return this.execute(args.signature, args.session, calls, args.options);
  }

  async close<TOpenIntent, TCloseIntent>(args: {
    signature: string;
    session: PrivateLaunchpadSession;
    adapter: LaunchpadAdapter<TOpenIntent, TCloseIntent>;
    intent: TCloseIntent;
    options?: ExecuteOptions;
  }): Promise<Hash> {
    this.assertAdapterChain(args.adapter);
    const calls = await args.adapter.buildCloseCalls(args.intent, {
      account: args.session.account,
      publicClient: this.config.publicClient,
    });
    return this.execute(args.signature, args.session, calls, args.options);
  }

  async execute(
    signature: string,
    session: PrivateLaunchpadSession,
    calls: readonly ExecutionCall[],
    options: ExecuteOptions = {},
  ): Promise<Hash> {
    if (calls.length === 0)
      throw new Error("cannot execute an empty call batch");
    const request = await this.prepareRelayRequest(
      signature,
      session,
      calls,
      options,
    );
    return this.config.relay(request);
  }

  /**
   * Waits until Base has included an execution. A returned transaction hash is
   * only proof of broadcast; callers should use this before showing success.
   */
  async waitForExecution(
    transactionHash: Hash,
  ): Promise<ExecutionConfirmation> {
    const receipt = await this.config.publicClient.waitForTransactionReceipt({
      hash: transactionHash,
      confirmations: 1,
      timeout: 120_000,
    });
    return {
      transactionHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
    };
  }

  /** Reads an ERC-20 balance held by a derived private-position account. */
  async readSessionTokenBalance(
    session: PrivateLaunchpadSession,
    token: Address,
  ): Promise<bigint> {
    return this.readAccountTokenBalance(session.account, token);
  }

  /** Reads an ERC-20 balance from a known position account without deriving it. */
  async readAccountTokenBalance(
    account: Address,
    token: Address,
  ): Promise<bigint> {
    return this.config.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    });
  }

  async returnSession(args: {
    signature: string;
    session: PrivateLaunchpadSession;
    connectedEvmAddress: Address;
    amount?: bigint;
    fee?: RelayerFee;
    onStep?: BridgeStepCallback;
  }): Promise<BridgeReturnResult> {
    const fee = args.fee ?? NO_RELAYER_FEE;
    const readBalance = async (): Promise<bigint> =>
      this.config.publicClient.readContract({
        address: this.config.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [args.session.account],
      });

    if (this.config.returnTransport) {
      const balance = await readBalance();
      const feeInUsdc =
        fee.token.toLowerCase() === this.config.usdc.toLowerCase()
          ? fee.amount
          : 0n;
      const maximum = balance > feeInUsdc ? balance - feeInUsdc : 0n;
      const amount = args.amount ?? maximum;
      if (amount <= 0n || amount > maximum) {
        throw new Error(
          `invalid return amount: maximum after relayer fee is ${maximum}`,
        );
      }
      return this.config.returnTransport({
        bridge: this.config.bridge,
        signature: args.signature,
        session: args.session,
        connectedEvmAddress: args.connectedEvmAddress,
        amount,
        submitCalls: (calls, context) =>
          this.execute(args.signature, args.session, calls, {
            fee,
            ...(context?.relayRequestId
              ? { relayRequestId: context.relayRequestId }
              : {}),
            ...(context?.relayQuoteAttestation
              ? { relayQuoteAttestation: context.relayQuoteAttestation }
              : {}),
          }),
        waitForExecution: (transactionHash) =>
          this.waitForExecution(transactionHash),
        ...(args.onStep ? { onStep: args.onStep } : {}),
      });
    }

    return this.config.bridge.returnToPool({
      signature: args.signature,
      accountIndex: args.session.accountIndex,
      channel: args.session.channel,
      evmAddress: args.connectedEvmAddress,
      destChainId: this.config.chainId,
      readReturnableBalance: readBalance,
      prepareFreshReturn: async () => {
        const balance = await readBalance();
        const feeInUsdc =
          fee.token.toLowerCase() === this.config.usdc.toLowerCase()
            ? fee.amount
            : 0n;
        const maximum = balance > feeInUsdc ? balance - feeInUsdc : 0n;
        const amount = args.amount ?? maximum;
        if (amount <= 0n || amount > maximum) {
          throw new Error(
            `invalid return amount: maximum after relayer fee is ${maximum}`,
          );
        }

        return {
          amount,
          depositWallet: args.session.account,
          submitGaslessBatch: async (burnCalls) => {
            const calls: ExecutionCall[] = burnCalls.map((call) => ({
              target: call.target as Address,
              value: 0n,
              data: call.data,
            }));
            return this.execute(args.signature, args.session, calls, { fee });
          },
        };
      },
      ...(args.onStep === undefined ? {} : { onStep: args.onStep }),
    });
  }

  /** Returns several idle USDG balances through one shared private merge. */
  async returnSessions(args: {
    signature: string;
    accountIndexes: readonly number[];
    connectedEvmAddress: Address;
    onStep?: BridgeStepCallback;
  }): Promise<BridgeBatchReturnResult> {
    if (!this.config.batchReturnTransport) {
      throw new Error("batched private return is not configured");
    }
    const uniqueIndexes = [...new Set(args.accountIndexes)];
    if (
      uniqueIndexes.length === 0 ||
      uniqueIndexes.some((index) => !Number.isSafeInteger(index) || index < 0)
    ) {
      throw new Error("batch return requires valid position account indexes");
    }
    const sources = [];
    for (const accountIndex of uniqueIndexes) {
      const session = await retryRateLimitedRead(() =>
        this.deriveSession(args.signature, accountIndex),
      );
      const amount = await retryRateLimitedRead(() =>
        this.config.publicClient.readContract({
          address: this.config.usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [session.account],
        }),
      );
      if (amount <= 0n) continue;
      sources.push({
        session,
        amount,
        submitCalls: (
          calls: readonly ExecutionCall[],
          context?: {
            relayRequestId?: string;
            relayQuoteAttestation?: string;
          },
        ) =>
          this.execute(args.signature, session, calls, {
            ...(context?.relayRequestId
              ? { relayRequestId: context.relayRequestId }
              : {}),
            ...(context?.relayQuoteAttestation
              ? { relayQuoteAttestation: context.relayQuoteAttestation }
              : {}),
          }),
        waitForExecution: (transactionHash: Hash) =>
          this.waitForExecution(transactionHash),
      });
    }
    return this.config.batchReturnTransport({
      bridge: this.config.bridge,
      signature: args.signature,
      connectedEvmAddress: args.connectedEvmAddress,
      sources,
      ...(args.onStep ? { onStep: args.onStep } : {}),
    });
  }

  /** Public emergency recovery from several position accounts to the root wallet. */
  async returnSessionsToWallet(args: {
    signature: string;
    accountIndexes: readonly number[];
    connectedEvmAddress: Address;
    authorize(message: string): Promise<string>;
    onStep?: BridgeStepCallback;
  }): Promise<WalletBatchReturnResult> {
    const uniqueIndexes = [...new Set(args.accountIndexes)];
    if (
      uniqueIndexes.length === 0 ||
      uniqueIndexes.length > 20 ||
      uniqueIndexes.some((index) => !Number.isSafeInteger(index) || index < 0)
    ) {
      throw new Error(
        "direct wallet recovery requires between 1 and 20 valid account indexes",
      );
    }

    const sources = [];
    for (const accountIndex of uniqueIndexes) {
      const session = await retryRateLimitedRead(() =>
        this.deriveSession(args.signature, accountIndex),
      );
      const amount = await retryRateLimitedRead(() =>
        this.config.publicClient.readContract({
          address: this.config.usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [session.account],
        }),
      );
      if (amount > 0n) sources.push({ session, amount });
    }
    const recipient = getAddress(args.connectedEvmAddress);
    if (sources.length === 0) {
      // A retry can arrive after the earlier recovery was broadcast. Treat an
      // empty source set as already recovered so the UI never asks the wallet
      // to authorize a duplicate transfer.
      return {
        amountReturned: 0n,
        recipient,
        sourceAccountIndexes: [],
        transactionHashes: [],
      };
    }
    sources.sort((left, right) =>
      left.session.account
        .toLowerCase()
        .localeCompare(right.session.account.toLowerCase()),
    );

    const authorizationDeadline = BigInt(
      Math.floor(Date.now() / 1_000) + DEFAULT_DEADLINE_SECONDS,
    );
    const authorizationBase = {
      recipient,
      accounts: sources.map(({ session, amount }) => ({
        account: session.account,
        amount,
      })),
      deadline: authorizationDeadline,
    } as const;
    const rootSignature = await args.authorize(
      walletRecoveryMessage({
        chainId: this.config.chainId,
        factory: this.config.factory,
        ...authorizationBase,
      }),
    );
    if (!/^0x[0-9a-fA-F]{130}$/.test(rootSignature)) {
      throw new Error("wallet recovery authorization signature is invalid");
    }
    const authorization: WalletRecoveryAuthorization = {
      ...authorizationBase,
      signature: rootSignature as Hex,
    };

    let amountReturned = 0n;
    const sourceAccountIndexes: number[] = [];
    const transactionHashes: Hash[] = [];
    for (const [index, source] of sources.entries()) {
      args.onStep?.(
        "wallet-return",
        "running",
        `returning account ${index + 1} of ${sources.length} directly to the connected wallet`,
      );
      const transactionHash = await this.execute(
        args.signature,
        source.session,
        [
          {
            target: this.config.usdc,
            value: 0n,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [recipient, source.amount],
            }),
          },
        ],
        {
          deadlineSeconds: 5 * 60,
          walletRecoveryAuthorization: authorization,
        },
      );
      // Retrying this read is safe: the transaction hash is already fixed and
      // no additional recovery transaction is submitted by receipt polling.
      const confirmation = await retryRateLimitedRead(() =>
        this.waitForExecution(transactionHash),
      );
      if (confirmation.status !== "success") {
        throw new Error("direct USDG wallet recovery reverted");
      }
      transactionHashes.push(transactionHash);
      sourceAccountIndexes.push(source.session.accountIndex);
      amountReturned += source.amount;
      args.onStep?.(
        "wallet-return",
        "done",
        `${index + 1}/${sources.length} accounts recovered`,
      );
    }

    return {
      amountReturned,
      recipient,
      sourceAccountIndexes,
      transactionHashes,
    };
  }

  encodeRelayCalldata(request: RelayExecutionRequest): Hex {
    return encodeFunctionData({
      abi: privateLaunchpadAccountFactoryAbi,
      functionName: "deployAndExecute",
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
      ],
    });
  }

  private async prepareRelayRequest(
    signature: string,
    session: PrivateLaunchpadSession,
    calls: readonly ExecutionCall[],
    options: ExecuteOptions,
  ): Promise<RelayExecutionRequest> {
    const derived = this.config.bridge.deriveEvmOwner(
      signature,
      session.accountIndex,
      session.channel,
    );
    if (derived.address.toLowerCase() !== session.owner.toLowerCase()) {
      throw new Error(
        "signature does not control the selected private launchpad session",
      );
    }

    const code = await this.config.publicClient.getBytecode({
      address: session.account,
    });
    const nonce = code
      ? await this.config.publicClient.readContract({
          address: session.account,
          abi: privateLaunchpadAccountAbi,
          functionName: "nonce",
        })
      : 0n;
    const deadlineSeconds = options.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
    if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds <= 0) {
      throw new Error("deadlineSeconds must be a positive safe integer");
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
    const prefund = options.prefund ?? 0n;
    const fee = options.fee ?? NO_RELAYER_FEE;
    const privateKey = derived.privateKey as Hex;
    const signedCalls = [...calls];
    const relaySignature = await signExecution({
      privateKey,
      ...(this.config.executionDomainName
        ? { executionDomainName: this.config.executionDomainName }
        : {}),
      chainId: this.config.chainId,
      account: session.account,
      calls: signedCalls,
      nonce,
      deadline,
      fee,
      prefund,
    });
    return {
      chainId: this.config.chainId,
      factory: this.config.factory,
      account: session.account,
      owner: session.owner,
      accountIndex: session.accountIndex,
      calls: signedCalls,
      nonce,
      deadline,
      prefund,
      fee,
      signature: relaySignature,
      ...(options.relayRequestId
        ? { relayRequestId: options.relayRequestId }
        : {}),
      ...(options.relayQuoteAttestation
        ? { relayQuoteAttestation: options.relayQuoteAttestation }
        : {}),
      ...(options.walletRecoveryAuthorization
        ? {
            walletRecoveryAuthorization: options.walletRecoveryAuthorization,
          }
        : {}),
    };
  }

  private assertAdapterChain(
    adapter: LaunchpadAdapter<unknown, unknown>,
  ): void {
    if (adapter.chainId !== this.config.chainId) {
      throw new Error(
        `adapter ${adapter.id} targets chain ${adapter.chainId}, client targets ${this.config.chainId}`,
      );
    }
  }
}

async function retryRateLimitedRead<T>(read: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RECOVERY_RPC_READ_ATTEMPTS; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        !/too many requests|\b429\b|rate[ -]?limit/i.test(message) ||
        attempt + 1 >= RECOVERY_RPC_READ_ATTEMPTS
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        globalThis.setTimeout(
          resolve,
          RECOVERY_RPC_RETRY_BASE_MS * 2 ** attempt,
        ),
      );
    }
  }
  throw lastError;
}
