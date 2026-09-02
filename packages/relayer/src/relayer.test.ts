import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  encodeFunctionData,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  erc20Abi,
  NO_RELAYER_FEE,
  signExecution,
  type RelayExecutionRequest,
} from "@private-launchpad/sdk";
import {
  PrivateLaunchpadRelayer,
  relayerFromEnv,
  validateStaticPolicy,
} from "./relayer.js";

const OWNER_KEY = `0x${"11".repeat(32)}` as Hex;
const RELAYER_KEY = `0x${"22".repeat(32)}` as Hex;
const FACTORY = "0x1111111111111111111111111111111111111111" as Address;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;
const TARGET = "0x3333333333333333333333333333333333333333" as Address;
const TX_HASH = `0x${"44".repeat(32)}` as Hash;
const BASE_ENV = {
  CHAIN_ID: "84532",
  FACTORY_ADDRESS: FACTORY,
  RPC_URL: "http://127.0.0.1:8545",
  RELAYER_PRIVATE_KEY: RELAYER_KEY,
} satisfies NodeJS.ProcessEnv;

async function signedRequest(
  calls: RelayExecutionRequest["calls"] = [
    { target: TARGET, value: 0n, data: "0x1234" as Hex },
  ],
): Promise<RelayExecutionRequest> {
  const owner = privateKeyToAccount(OWNER_KEY).address;
  const request = {
    chainId: 84532,
    factory: FACTORY,
    account: ACCOUNT,
    owner,
    accountIndex: 4,
    calls,
    nonce: 0n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    prefund: 0n,
    fee: NO_RELAYER_FEE,
  } as const;
  return {
    ...request,
    signature: await signExecution({ privateKey: OWNER_KEY, ...request }),
  };
}

function fixture(
  accountNonce?: bigint,
  relayerGasBalance = 1n,
  options: {
    tokenBalances?: bigint[];
    simulationErrors?: Error[];
  } = {},
) {
  const tokenBalances = [...(options.tokenBalances ?? [])];
  const simulationErrors = [...(options.simulationErrors ?? [])];
  const simulateContract = vi.fn(async (request: unknown) => {
    const error = simulationErrors.shift();
    if (error) throw error;
    return { request };
  });
  const writeContract = vi.fn(async () => TX_HASH);
  const sleep = vi.fn(async () => undefined);
  const publicClient = {
    getBalance: vi.fn(async () => relayerGasBalance),
    getBytecode: vi.fn(async () =>
      accountNonce === undefined ? undefined : ("0x01" as Hex),
    ),
    readContract: vi.fn(async (args: { functionName: string }) => {
      if (args.functionName === "computeAddress") return ACCOUNT;
      if (args.functionName === "nonce") return accountNonce;
      if (args.functionName === "balanceOf") {
        return tokenBalances.shift() ?? 0n;
      }
      throw new Error(`unexpected read: ${args.functionName}`);
    }),
    simulateContract,
  } as unknown as PublicClient;
  const walletClient = { writeContract } as unknown as WalletClient;
  const relayerAccount = privateKeyToAccount(RELAYER_KEY);
  const relayer = new PrivateLaunchpadRelayer(
    {
      chainId: 84532,
      factory: FACTORY,
      fee: NO_RELAYER_FEE,
      maxCalls: 4,
      maxCalldataBytes: 1024,
      maxDeadlineSeconds: 900,
      maxPrefund: 0n,
      allowedTargets: new Set([TARGET.toLowerCase()]),
    },
    { publicClient, walletClient, relayerAccount, sleep },
  );
  return { relayer, simulateContract, writeContract, sleep };
}

describe("private launchpad relayer", () => {
  it("verifies, simulates, and broadcasts an owner-signed request", async () => {
    const request = await signedRequest();
    const { relayer, simulateContract, writeContract } = fixture();

    await expect(relayer.relay(request)).resolves.toBe(TX_HASH);
    expect(simulateContract).toHaveBeenCalledOnce();
    expect(writeContract).toHaveBeenCalledOnce();
  });

  it("rejects a stale account nonce before simulation", async () => {
    const request = await signedRequest();
    const { relayer, simulateContract } = fixture(1n);

    await expect(relayer.relay(request)).rejects.toThrow(/stale account nonce/);
    expect(simulateContract).not.toHaveBeenCalled();
  });

  it("rejects an empty gas account before broadcast", async () => {
    const request = await signedRequest();
    const { relayer, simulateContract, writeContract } = fixture(undefined, 0n);

    await expect(relayer.relay(request)).rejects.toThrow(
      /relayer gas account .* has no Robinhood ETH/,
    );
    expect(simulateContract).toHaveBeenCalledOnce();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("waits until a just-funded execution account exposes the approved spend", async () => {
    const request = await signedRequest([
      {
        target: TARGET,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [FACTORY, 10n],
        }),
      },
    ]);
    const { relayer, simulateContract, sleep } = fixture(undefined, 1n, {
      tokenBalances: [0n, 4n, 10n],
    });

    await expect(relayer.relay(request)).resolves.toBe(TX_HASH);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(simulateContract).toHaveBeenCalledOnce();
  });

  it("retries an opaque return-transfer simulation for a funded fresh account", async () => {
    const request = await signedRequest([
      {
        target: TARGET,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [FACTORY, 10n],
        }),
      },
    ]);
    const { relayer, simulateContract, sleep } = fixture(undefined, 1n, {
      tokenBalances: [10n],
      simulationErrors: [
        new Error('The contract function "deployAndExecute" reverted.'),
        new Error('The contract function "deployAndExecute" reverted.'),
      ],
    });

    await expect(relayer.relay(request)).resolves.toBe(TX_HASH);
    expect(simulateContract).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not simulate when fresh-account funding is still missing", async () => {
    const request = await signedRequest([
      {
        target: TARGET,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [FACTORY, 10n],
        }),
      },
    ]);
    const { relayer, simulateContract, sleep } = fixture(undefined, 1n, {
      tokenBalances: [0n, 0n, 0n, 0n, 0n, 0n],
    });

    await expect(relayer.relay(request)).rejects.toThrow(
      /funding is not visible.*available 0, required 10/i,
    );
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(simulateContract).not.toHaveBeenCalled();
  });

  it("retries an opaque pre-broadcast revert for a just-funded account", async () => {
    const request = await signedRequest([
      {
        target: TARGET,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [FACTORY, 10n],
        }),
      },
    ]);
    const { relayer, simulateContract, sleep } = fixture(undefined, 1n, {
      tokenBalances: [10n],
      simulationErrors: [
        new Error('The contract function "deployAndExecute" reverted.'),
        new Error('The contract function "deployAndExecute" reverted.'),
      ],
    });

    await expect(relayer.relay(request)).resolves.toBe(TX_HASH);
    expect(simulateContract).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe("relayer environment policy", () => {
  it("loads a deployment-specific execution domain", () => {
    const relayer = relayerFromEnv({
      ...BASE_ENV,
      EXECUTION_DOMAIN_NAME: "PonsPrivacyAccount",
      ALLOWED_TARGETS: TARGET,
    });

    expect(relayer.policy.executionDomainName).toBe("PonsPrivacyAccount");
  });

  it("fails closed when no target allowlist is configured", () => {
    expect(() => relayerFromEnv(BASE_ENV)).toThrow(
      /ALLOWED_TARGETS is required/,
    );
  });

  it("normalizes and enforces an explicit target allowlist", () => {
    const relayer = relayerFromEnv({
      ...BASE_ENV,
      ALLOWED_TARGETS: TARGET.toUpperCase().replace("0X", "0x"),
    });

    expect(relayer.policy.allowedTargets).toEqual(
      new Set([TARGET.toLowerCase()]),
    );
  });

  it("permits an explicit unsafe development override", () => {
    const relayer = relayerFromEnv({
      ...BASE_ENV,
      ALLOW_UNSAFE_ANY_TARGETS: "true",
    });

    expect(relayer.policy.allowedTargets).toBeUndefined();
  });

  it("requires a quote-attestation key for the Pons return policy", () => {
    expect(() =>
      relayerFromEnv({
        ...BASE_ENV,
        CHAIN_ID: "4663",
        PONS_V2_POLICY: "true",
      }),
    ).toThrow(/RELAY_QUOTE_ATTESTATION_KEY is required/);

    const relayer = relayerFromEnv({
      ...BASE_ENV,
      CHAIN_ID: "4663",
      PONS_V2_POLICY: "true",
      RELAY_QUOTE_ATTESTATION_KEY: "11".repeat(32),
    });
    expect(relayer.policy.semanticValidator).toBeTypeOf("function");
  });

  it("allows only proxy-bound ERC-20 approvals on dynamic token targets", async () => {
    const proxy = "0x7777777777777777777777777777777777777777" as Address;
    const request = await signedRequest();
    request.calls = [
      {
        target: "0x8888888888888888888888888888888888888888",
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [proxy, 10n],
        }),
      },
    ];
    const relayer = relayerFromEnv({
      ...BASE_ENV,
      ALLOWED_TARGETS: TARGET,
      ALLOW_UNISWAP_PROXY_APPROVALS: "true",
      UNISWAP_PROXY_ADDRESS: proxy,
    });

    expect(() => validateStaticPolicy(request, relayer.policy)).not.toThrow();
    request.calls = [{ ...request.calls[0]!, value: 1n }];
    expect(() => validateStaticPolicy(request, relayer.policy)).toThrow(
      /target not allowed/,
    );
  });

  it.each(["yes", "TRUE", "1"])(
    "rejects invalid unsafe override value %s",
    (value) => {
      expect(() =>
        relayerFromEnv({
          ...BASE_ENV,
          ALLOW_UNSAFE_ANY_TARGETS: value,
        }),
      ).toThrow(/must be true or false/);
    },
  );

  it.each([
    ["RELAYER_FEE_AMOUNT", "-1"],
    ["RELAYER_FEE_AMOUNT", "1.5"],
    ["MAX_PREFUND_WEI", "-1"],
    ["MAX_PREFUND_WEI", "0x10"],
  ])("rejects invalid unsigned integer %s=%s", (name, value) => {
    expect(() =>
      relayerFromEnv({
        ...BASE_ENV,
        ALLOWED_TARGETS: TARGET,
        [name]: value,
      }),
    ).toThrow(/must be a non-negative integer/);
  });
});
