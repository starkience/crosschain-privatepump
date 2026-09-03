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
  const moveIntoPool = vi.fn(async (args) => ({
    depositedNetWei: args.amountWei,
    deposited: true,
  }));
  const cashOut = vi.fn(async (args) => ({
    burnTxHash: "cash-burn",
    destination: args.destination,
    forwardTxHash: "cash-forward",
    amountNet: args.amount,
  }));
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
  const readPrivateBalance = vi.fn(async () => balance);
  const readPendingDeposit = vi.fn(async () => 25_000_000n);
  const waitForTransactionReceipt = vi.fn(async () => ({
    status: "success" as const,
    blockNumber: 321n,
  }));
  const bridge: PrivacyBridgeEngine = {
    deriveEvmOwner: () => ({ address: OWNER, privateKey: PRIVATE_KEY }),
    readPrivateBalance,
    readPendingDeposit,
    moveIntoPool,
    cashOut,
    fundAccountFromPool,
    returnToPool,
  };
  const publicClient = {
    getBytecode: vi.fn(async () => undefined),
    waitForTransactionReceipt,
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
  return {
    client,
    cashOut,
    fundAccountFromPool,
    moveIntoPool,
    readPrivateBalance,
    readPendingDeposit,
    relayRequests,
    returnToPool,
    waitForTransactionReceipt,
  };
}

describe("private launchpad client", () => {
  it("discovers the recoverable STRK20 balance", async () => {
    const { client, readPrivateBalance } = fixture(25_000_000n);
    await expect(client.readPrivateBalance("0x1234")).resolves.toBe(
      25_000_000n,
    );
    expect(readPrivateBalance).toHaveBeenCalledWith("0x1234");
  });

  it("discovers a deposit awaiting the final STRK20 step", async () => {
    const { client, readPendingDeposit } = fixture();
    await expect(client.readPendingDeposit("0x1234")).resolves.toBe(
      25_000_000n,
    );
    expect(readPendingDeposit).toHaveBeenCalledWith("0x1234");
  });

  it("waits for Base confirmation before reporting execution success", async () => {
    const { client, waitForTransactionReceipt } = fixture();
    await expect(client.waitForExecution(TX_HASH)).resolves.toEqual({
      transactionHash: TX_HASH,
      status: "success",
      blockNumber: 321n,
    });
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: TX_HASH,
      confirmations: 1,
      timeout: 120_000,
    });
  });

  it("reads the live token balance from the private position account", async () => {
    const { client } = fixture(1_240n);
    const session = await client.deriveSession("app-signature", 2);
    await expect(client.readSessionTokenBalance(session, TARGET)).resolves.toBe(
      1_240n,
    );
    await expect(
      client.readAccountTokenBalance(session.account, TARGET),
    ).resolves.toBe(1_240n);
  });

  it("deposits connected-wallet USDC into the private balance", async () => {
    const { client, moveIntoPool } = fixture();
    const provider = { request: vi.fn(async () => [CONNECTED]) };
    await expect(
      client.depositToPrivateBalance({
        signature: "0x1234",
        amount: 50n,
        provider,
      }),
    ).resolves.toEqual({ depositedNetWei: 50n, deposited: true });
    expect(moveIntoPool).toHaveBeenCalledWith(
      expect.objectContaining({
        funding: "metamask",
        amountWei: 50n,
        provider,
        sourceChainId: 84532,
      }),
    );
  });

  it("resumes only the final pool step without a fresh Base burn", async () => {
    const { client, moveIntoPool } = fixture();
    const provider = { request: vi.fn(async () => [CONNECTED]) };
    await client.depositToPrivateBalance({
      signature: "0x1234",
      amount: 25n,
      provider,
      resume: true,
    });
    expect(moveIntoPool).toHaveBeenCalledWith(
      expect.objectContaining({
        amountWei: 25n,
        provider,
        resume: true,
      }),
    );
  });

  it("cashes private USDC out to a public EVM destination", async () => {
    const { cashOut, client } = fixture();
    await expect(
      client.withdrawPrivateBalance({
        signature: "0x1234",
        amount: 25n,
        destination: CONNECTED,
        connectedEvmAddress: CONNECTED,
      }),
    ).resolves.toEqual({
      burnTxHash: "cash-burn",
      destination: CONNECTED,
      forwardTxHash: "cash-forward",
      amountNet: 25n,
    });
    expect(cashOut).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 25n,
        destination: CONNECTED,
        evmAddress: CONNECTED,
        destChainId: 84532,
      }),
    );
  });

  it("returns an idle session balance directly to an authorized root wallet", async () => {
    const { client, relayRequests, waitForTransactionReceipt } = fixture(100n);
    const authorize = vi.fn(async () => `0x${"88".repeat(65)}`);

    await expect(
      client.returnSessionsToWallet({
        signature: "0x1234",
        accountIndexes: [7],
        connectedEvmAddress: CONNECTED,
        authorize,
      }),
    ).resolves.toMatchObject({
      amountReturned: 100n,
      recipient: CONNECTED,
      sourceAccountIndexes: [7],
      transactionHashes: [TX_HASH],
    });
    expect(authorize).toHaveBeenCalledWith(
      expect.stringContaining("PonsButPrivate direct wallet recovery"),
    );
    expect(relayRequests).toHaveLength(1);
    expect(relayRequests[0]).toMatchObject({
      calls: [{ target: USDC, value: 0n }],
      walletRecoveryAuthorization: {
        recipient: CONNECTED,
        accounts: [{ account: ACCOUNT, amount: 100n }],
      },
    });
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: TX_HASH,
      confirmations: 1,
      timeout: 120_000,
    });
  });

  it("treats an empty direct-recovery retry as already completed", async () => {
    const { client, relayRequests } = fixture(0n);
    const authorize = vi.fn(async () => `0x${"88".repeat(65)}`);

    await expect(
      client.returnSessionsToWallet({
        signature: "0x1234",
        accountIndexes: [7],
        connectedEvmAddress: CONNECTED,
        authorize,
      }),
    ).resolves.toEqual({
      amountReturned: 0n,
      recipient: CONNECTED,
      sourceAccountIndexes: [],
      transactionHashes: [],
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(relayRequests).toHaveLength(0);
  });

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
