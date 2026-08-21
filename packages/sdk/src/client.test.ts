import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hash, Hex, PublicClient } from "viem";
import { PrivateLaunchpadClient } from "./client.js";
import type {
  BridgeFundResult,
  BridgeReturnResult,
  PrivacyBridgeEngine,
  RelayExecutionRequest,
} from "./types.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}` as Hex;
const OWNER = privateKeyToAccount(PRIVATE_KEY).address;
const FACTORY = "0x1111111111111111111111111111111111111111" as Address;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;
const USDC = "0x3333333333333333333333333333333333333333" as Address;
const TARGET = "0x4444444444444444444444444444444444444444" as Address;
const CONNECTED = "0x5555555555555555555555555555555555555555" as Address;
const RELAYER = "0x6666666666666666666666666666666666666666" as Address;
const TX_HASH = `0x${"77".repeat(32)}` as Hash;

function fixture(balance = 100n) {
  const relayRequests: RelayExecutionRequest[] = [];
  const fundAccountFromPool = vi.fn(
    async (args: Parameters<PrivacyBridgeEngine["fundAccountFromPool"]>[0]) => {
      expect(await args.resolveDepositWallet("ignored", 0)).toBe(ACCOUNT);
      return {
        burnTxHash: "burn",
        accountIndex: args.accountIndex,
        eoaAddress: OWNER,
        depositWallet: ACCOUNT,
        commitmentH: 1n,
        forwardTxHash: "forward",
      } satisfies BridgeFundResult;
    },
  );
  const returnToPool = vi.fn(
    async (args: Parameters<PrivacyBridgeEngine["returnToPool"]>[0]) => {
      const prepared = await args.prepareFreshReturn();
      await prepared.submitGaslessBatch([{ target: TARGET, data: "0x1234" }]);
      return {
        amountReturned: prepared.amount,
        claimTxHash: "claim",
        ranFreshBurn: true,
        alreadyClaimed: false,
      } satisfies BridgeReturnResult;
    },
  );
  const bridge: PrivacyBridgeEngine = {
    deriveEvmOwner: () => ({ address: OWNER, privateKey: PRIVATE_KEY }),
    fundAccountFromPool,
    returnToPool,
  };
  const publicClient = {
    getBytecode: vi.fn(async () => undefined),
    readContract: vi.fn(async (args: { functionName: string }) => {
      if (args.functionName === "computeAddress") return ACCOUNT;
      if (args.functionName === "balanceOf") return balance;
      throw new Error(`unexpected read: ${args.functionName}`);
    }),
  } as unknown as PublicClient;
  const client = new PrivateLaunchpadClient({
    chainId: 84532,
    factory: FACTORY,
    usdc: USDC,
    publicClient,
    bridge,
    relay: async (request) => {
      relayRequests.push(request);
      return TX_HASH;
    },
  });
  return { client, fundAccountFromPool, relayRequests, returnToPool };
}

describe("private launchpad client", () => {
  it("bridges directly to the deterministic smart account", async () => {
    const { client, fundAccountFromPool } = fixture();
    const result = await client.fundSession({
      signature: "app-signature",
      accountIndex: 7,
      amount: 25n,
      connectedEvmAddress: CONNECTED,
    });

    expect(result.depositWallet).toBe(ACCOUNT);
    expect(fundAccountFromPool).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIndex: 7,
        amount: 25n,
        destChainId: 84532,
        channel: "private-launchpad-v1",
      }),
    );
  });

  it("reserves a USDC relayer fee before returning the balance to STRK20", async () => {
    const { client, relayRequests, returnToPool } = fixture(100n);
    const session = await client.deriveSession("app-signature", 2);
    const result = await client.returnSession({
      signature: "app-signature",
      session,
      connectedEvmAddress: CONNECTED,
      fee: { token: USDC, amount: 3n, recipient: RELAYER },
    });

    expect(result.amountReturned).toBe(97n);
    expect(returnToPool).toHaveBeenCalledOnce();
    expect(relayRequests).toHaveLength(1);
    expect(relayRequests[0]).toMatchObject({
      account: ACCOUNT,
      owner: OWNER,
      accountIndex: 2,
      nonce: 0n,
      prefund: 0n,
      fee: { token: USDC, amount: 3n, recipient: RELAYER },
    });
    expect(relayRequests[0]!.calls).toEqual([
      { target: TARGET, value: 0n, data: "0x1234" },
    ]);
    expect(relayRequests[0]!.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("rejects returning more than the fee-adjusted balance", async () => {
    const { client } = fixture(10n);
    const session = await client.deriveSession("app-signature", 2);
    await expect(
      client.returnSession({
        signature: "app-signature",
        session,
        connectedEvmAddress: CONNECTED,
        amount: 10n,
        fee: { token: USDC, amount: 1n, recipient: RELAYER },
      }),
    ).rejects.toThrow(/maximum after relayer fee is 9/);
  });
});
