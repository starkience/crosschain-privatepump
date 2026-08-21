import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hash, Hex, PublicClient, WalletClient } from "viem";
import {
  NO_RELAYER_FEE,
  signExecution,
  type RelayExecutionRequest,
} from "@private-launchpad/sdk";
import { PrivateLaunchpadRelayer, relayerFromEnv } from "./relayer.js";

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

async function signedRequest(): Promise<RelayExecutionRequest> {
  const owner = privateKeyToAccount(OWNER_KEY).address;
  const request = {
    chainId: 84532,
    factory: FACTORY,
    account: ACCOUNT,
    owner,
    accountIndex: 4,
    calls: [{ target: TARGET, value: 0n, data: "0x1234" as Hex }],
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

function fixture(accountNonce?: bigint) {
  const simulateContract = vi.fn(async (request: unknown) => ({ request }));
  const writeContract = vi.fn(async () => TX_HASH);
  const publicClient = {
    getBytecode: vi.fn(async () =>
      accountNonce === undefined ? undefined : ("0x01" as Hex),
    ),
    readContract: vi.fn(async (args: { functionName: string }) => {
      if (args.functionName === "computeAddress") return ACCOUNT;
      if (args.functionName === "nonce") return accountNonce;
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
    { publicClient, walletClient, relayerAccount },
  );
  return { relayer, simulateContract, writeContract };
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
});

describe("relayer environment policy", () => {
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
