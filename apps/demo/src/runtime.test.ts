import { describe, expect, it, vi } from "vitest";
import type {
  ClankerTradeQuote,
  ClankerTradeSide,
  LaunchpadAdapter,
  PrivateLaunchpadClient,
  PrivateLaunchpadSession,
} from "@private-launchpad/sdk";
import {
  createLiveRuntime,
  type LaunchDraft,
  type TradeDraft,
} from "./runtime.js";

const address =
  "0x1111111111111111111111111111111111111111" as PrivateLaunchpadSession["account"];
const session: PrivateLaunchpadSession = {
  accountIndex: 3,
  channel: "private-launchpad-v1",
  owner: "0x2222222222222222222222222222222222222222",
  account: "0x3333333333333333333333333333333333333333",
};
const draft: LaunchDraft = {
  name: "Night Market",
  symbol: "NITE",
  description: "Night market token",
  bridgeAmount: 25_000_000n,
  creatorReward: 40,
  salt: `0x${"11".repeat(32)}`,
};

describe("live frontend runtime", () => {
  it("reuses one identity signature while deriving a requested position index", async () => {
    const deriveSession = vi.fn(async (_signature: string, index: number) => ({
      ...session,
      accountIndex: index,
    }));
    const signIdentity = vi.fn(async () => "wallet-signature");
    const runtime = createLiveRuntime({
      appId: "launch.example",
      accountIndex: 3,
      client: { deriveSession } as unknown as PrivateLaunchpadClient,
      adapter: { id: "host", chainId: 84532 } as LaunchpadAdapter<
        LaunchDraft,
        never
      >,
      connectWallet: async () => address,
      signIdentity,
      buildOpenIntent: (intent) => intent,
    });

    await runtime.prepareIdentity(12);
    await runtime.prepareIdentity(13);
    expect(deriveSession).toHaveBeenNthCalledWith(1, "wallet-signature", 12);
    expect(deriveSession).toHaveBeenNthCalledWith(2, "wallet-signature", 13);
    expect(signIdentity).toHaveBeenCalledOnce();
  });

  it("executes the exact validated trade quote and returns real output amounts", async () => {
    const execute = vi.fn(async () => `0x${"77".repeat(32)}`);
    const quote = vi.fn(
      async (
        side: ClankerTradeSide,
        intent: TradeDraft,
        selectedSession: PrivateLaunchpadSession,
      ): Promise<ClankerTradeQuote> => ({
        requestId: "quote-1",
        chainId: 84532,
        account: selectedSession.account,
        usdc: "0x6666666666666666666666666666666666666666" as PrivateLaunchpadSession["account"],
        token: intent.token,
        side,
        amountIn: intent.amountIn,
        slippageBps: 100,
        amountOut: 2_000n,
        minimumAmountOut: 1_900n,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        calls: [
          {
            target:
              "0x7777777777777777777777777777777777777777" as PrivateLaunchpadSession["account"],
            value: 0n,
            data: "0x1234" as `0x${string}`,
          },
        ],
      }),
    );
    const runtime = createLiveRuntime({
      appId: "launch.example",
      accountIndex: 3,
      client: {
        deriveSession: vi.fn(async () => session),
        execute,
      } as unknown as PrivateLaunchpadClient,
      adapter: { id: "host", chainId: 84532 } as LaunchpadAdapter<
        LaunchDraft,
        never
      >,
      connectWallet: async () => address,
      signIdentity: async () => "wallet-signature",
      buildOpenIntent: (intent) => intent,
      trade: {
        buildIntent: (intent) => intent,
        quote,
      },
    });

    await runtime.prepareIdentity();
    const trade = await runtime.buy({
      token: "0x8888888888888888888888888888888888888888",
      amountIn: 25_000_000n,
      slippageBps: 100,
    });
    expect(trade).toMatchObject({
      amountIn: 25_000_000n,
      amountOut: 2_000n,
      minimumAmountOut: 1_900n,
    });
    expect(quote).toHaveBeenCalledWith("buy", expect.any(Object), session);
    expect(execute).toHaveBeenCalledWith(
      "wallet-signature",
      session,
      expect.arrayContaining([
        expect.objectContaining({
          target: "0x7777777777777777777777777777777777777777",
        }),
      ]),
    );
  });

  it("reconciles a saved position without restoring signing material", async () => {
    const positionAccount =
      "0x9999999999999999999999999999999999999999" as PrivateLaunchpadSession["account"];
    const token =
      "0x8888888888888888888888888888888888888888" as PrivateLaunchpadSession["account"];
    const readAccountTokenBalance = vi.fn(async () => 1_240n);
    const quote = vi.fn(async (_side, intent: TradeDraft, quoteSession) => ({
      amountIn: intent.amountIn,
      amountOut: 24_200_000n,
      minimumAmountOut: 23_958_000n,
      calls: [],
      account: quoteSession.account,
    }));
    const connectWallet = vi.fn(async () => address);
    const signIdentity = vi.fn(async () => "wallet-signature");
    const runtime = createLiveRuntime({
      appId: "launch.example",
      accountIndex: 3,
      client: {
        channel: "private-launchpad-v1",
        readAccountTokenBalance,
      } as unknown as PrivateLaunchpadClient,
      adapter: { id: "host", chainId: 84532 } as LaunchpadAdapter<
        LaunchDraft,
        never
      >,
      connectWallet,
      signIdentity,
      buildOpenIntent: (intent) => intent,
      trade: {
        buildIntent: (intent) => intent,
        quote,
      },
    });

    await expect(
      runtime.readAccountTokenBalance(positionAccount, token),
    ).resolves.toBe(1_240n);
    await expect(
      runtime.quoteSell(positionAccount, {
        token,
        amountIn: 1_240n,
        slippageBps: 100,
      }),
    ).resolves.toMatchObject({ amountOut: 24_200_000n });

    expect(readAccountTokenBalance).toHaveBeenCalledWith(
      positionAccount,
      token,
    );
    expect(quote).toHaveBeenCalledWith(
      "sell",
      expect.any(Object),
      expect.objectContaining({ account: positionAccount }),
    );
    expect(connectWallet).not.toHaveBeenCalled();
    expect(signIdentity).not.toHaveBeenCalled();
  });

  it("supports an explicit wallet connection before private identity signing", async () => {
    const connectWallet = vi.fn(async () => address);
    const runtime = createLiveRuntime({
      appId: "launch.example",
      accountIndex: 3,
      client: {} as PrivateLaunchpadClient,
      adapter: { id: "host", chainId: 84532 } as LaunchpadAdapter<
        LaunchDraft,
        never
      >,
      connectWallet,
      signIdentity: async () => "wallet-signature",
      buildOpenIntent: (intent) => intent,
    });

    expect(await runtime.connectWallet()).toBe(address);
    expect(connectWallet).toHaveBeenCalledOnce();
  });

  it("keeps the identity signature inside the runtime during position recovery", async () => {
    const client = {
      deriveSession: vi.fn(async () => session),
    } as unknown as PrivateLaunchpadClient;
    const recoverPositions = vi.fn(async () => []);
    const runtime = createLiveRuntime({
      appId: "launch.example",
      accountIndex: 3,
      client,
      adapter: { id: "host", chainId: 84532 } as LaunchpadAdapter<
        LaunchDraft,
        never
      >,
      connectWallet: async () => address,
      signIdentity: async () => "wallet-signature",
      buildOpenIntent: (intent) => intent,
      recoverPositions,
    });

    await expect(runtime.recoverPositions?.()).rejects.toThrow(
      "prepare the private identity",
    );
    const prepared = await runtime.prepareIdentity();
    await expect(runtime.recoverPositions?.()).resolves.toEqual([]);
    expect(prepared).not.toHaveProperty("signature");
    expect(recoverPositions).toHaveBeenCalledWith({
      signature: "wallet-signature",
      connectedAddress: address,
      client,
    });
  });

  it("shares one pending MetaMask request across repeated clicks", async () => {
    let resolveWallet!: (value: typeof address) => void;
    const pendingWallet = new Promise<typeof address>((resolve) => {
      resolveWallet = resolve;
    });
    const connectWallet = vi.fn(() => pendingWallet);
    const runtime = createLiveRuntime({
      appId: "launch.example",
      accountIndex: 3,
      client: {} as PrivateLaunchpadClient,
      adapter: { id: "host", chainId: 84532 } as LaunchpadAdapter<
        LaunchDraft,
        never
      >,
      connectWallet,
      signIdentity: async () => "wallet-signature",
      buildOpenIntent: (intent) => intent,
    });

    const first = runtime.connectWallet();
    const second = runtime.connectWallet();
    expect(connectWallet).toHaveBeenCalledOnce();

    resolveWallet(address);
    await expect(Promise.all([first, second])).resolves.toEqual([
      address,
      address,
    ]);
  });

  it("rejects zero-USDC launches at the runtime boundary", async () => {
    const fundSession = vi.fn();
    const open = vi.fn();
    const runtime = createLiveRuntime({
      appId: "launch.example",
      accountIndex: 3,
      client: {
        deriveSession: vi.fn(async () => session),
        fundSession,
        open,
      } as unknown as PrivateLaunchpadClient,
      adapter: { id: "host", chainId: 84532 } as LaunchpadAdapter<
        LaunchDraft,
        never
      >,
      connectWallet: async () => address,
      signIdentity: async () => "wallet-signature",
      buildOpenIntent: (intent) => intent,
    });
    const zeroDraft = { ...draft, bridgeAmount: 0n };

    await runtime.prepareIdentity();
    await expect(runtime.fund(zeroDraft)).rejects.toThrow(
      /funding must be greater than zero/i,
    );
    await expect(runtime.launch(zeroDraft)).rejects.toThrow(
      /funding must be greater than zero/i,
    );
    expect(fundSession).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps the identity signature internal while calling the real SDK boundary", async () => {
    const deriveSession = vi.fn(async () => session);
    const readPrivateBalance = vi.fn(async () => 25_000_000n);
    const fundSession = vi.fn(async () => ({
      burnTxHash: "0xburn",
      accountIndex: 3,
      eoaAddress: session.owner,
      depositWallet: session.account,
      commitmentH: 1n,
      forwardTxHash: "0xfund",
    }));
    const open = vi.fn(async () => "0xlaunch");
    const client = {
      deriveSession,
      readPrivateBalance,
      fundSession,
      open,
    } as unknown as PrivateLaunchpadClient;
    const adapter = { id: "host", chainId: 84532 } as LaunchpadAdapter<
      LaunchDraft,
      never
    >;
    const runtime = createLiveRuntime({
      appId: "launch.example",
      accountIndex: 3,
      client,
      adapter,
      connectWallet: async () => address,
      signIdentity: async ({ message }) => {
        expect(message).toContain("Application: launch.example");
        return "wallet-signature";
      },
      buildOpenIntent: (intent) => intent,
    });

    const identity = await runtime.prepareIdentity();
    expect(identity).toEqual({
      connectedAddress: address,
      storageScope: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      session,
    });
    expect(JSON.stringify(identity)).not.toContain("wallet-signature");

    await expect(runtime.readPrivateBalance()).resolves.toBe(25_000_000n);
    expect(readPrivateBalance).toHaveBeenCalledWith("wallet-signature");

    await runtime.fund(draft);
    await runtime.launch(draft);
    expect(deriveSession).toHaveBeenCalledWith("wallet-signature", 3);
    expect(fundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: "wallet-signature",
        connectedEvmAddress: address,
        amount: 25_000_000n,
        fast: true,
      }),
    );
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: "wallet-signature",
        session,
        adapter,
      }),
    );
  });

  it("launches from the saved account when an older bridge transfer resumes", async () => {
    const resumedSession: PrivateLaunchpadSession = {
      ...session,
      accountIndex: 9,
      owner: "0x4444444444444444444444444444444444444444",
      account: "0x5555555555555555555555555555555555555555",
    };
    const deriveSession = vi.fn(async (_signature: string, index: number) =>
      index === 9 ? resumedSession : session,
    );
    const fundSession = vi.fn(async () => ({
      burnTxHash: "0xold-burn",
      accountIndex: 9,
      eoaAddress: resumedSession.owner,
      depositWallet: resumedSession.account,
      commitmentH: 2n,
      forwardTxHash: "0xold-mint",
    }));
    const open = vi.fn(async () => "0xlaunch");
    const runtime = createLiveRuntime({
      appId: "launch.example",
      accountIndex: 3,
      client: {
        deriveSession,
        fundSession,
        open,
      } as unknown as PrivateLaunchpadClient,
      adapter: { id: "host", chainId: 84532 } as LaunchpadAdapter<
        LaunchDraft,
        never
      >,
      connectWallet: async () => address,
      signIdentity: async () => "wallet-signature",
      buildOpenIntent: (intent) => intent,
    });

    await runtime.prepareIdentity();
    await runtime.fund(draft);
    await runtime.launch(draft);

    expect(deriveSession).toHaveBeenLastCalledWith("wallet-signature", 9);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ session: resumedSession }),
    );
  });

  it("resolves a fresh host-owned account index before prompting the wallet", async () => {
    const events: string[] = [];
    const client = {
      deriveSession: vi.fn(async () => session),
    } as unknown as PrivateLaunchpadClient;
    const runtime = createLiveRuntime({
      appId: "launch.example",
      accountIndex: async () => {
        events.push("index");
        return 3;
      },
      client,
      adapter: { id: "host", chainId: 84532 } as LaunchpadAdapter<
        LaunchDraft,
        never
      >,
      connectWallet: async () => {
        events.push("wallet");
        return address;
      },
      signIdentity: async () => "wallet-signature",
      buildOpenIntent: (intent) => intent,
    });

    await runtime.prepareIdentity();
    expect(events).toEqual(["index", "wallet"]);
    expect(client.deriveSession).toHaveBeenCalledWith("wallet-signature", 3);
  });

  it("marks recovery as resume-only at the SDK boundary", async () => {
    const depositToPrivateBalance = vi.fn(async () => ({
      depositedNetWei: 25_000_000n,
      deposited: true,
    }));
    const client = {
      deriveSession: vi.fn(async () => session),
      depositToPrivateBalance,
    } as unknown as PrivateLaunchpadClient;
    const provider = { request: vi.fn() };
    const runtime = createLiveRuntime({
      appId: "launch.example",
      accountIndex: 3,
      client,
      adapter: { id: "host", chainId: 84532 } as LaunchpadAdapter<
        LaunchDraft,
        never
      >,
      connectWallet: async () => address,
      signIdentity: async () => "wallet-signature",
      buildOpenIntent: (intent) => intent,
      depositProvider: () => provider,
    });

    await runtime.prepareIdentity();
    await runtime.resumeDeposit(25_000_000n);
    expect(depositToPrivateBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: "wallet-signature",
        amount: 25_000_000n,
        provider,
        resume: true,
      }),
    );
  });

  it("forwards the public deposit transaction to the process logger", async () => {
    const depositToPrivateBalance = vi.fn(async () => ({
      depositedNetWei: 3_000_000n,
      deposited: true,
    }));
    const client = {
      deriveSession: vi.fn(async () => session),
      depositToPrivateBalance,
    } as unknown as PrivateLaunchpadClient;
    const provider = { request: vi.fn() };
    const runtime = createLiveRuntime({
      appId: "launch.example",
      accountIndex: 3,
      client,
      adapter: { id: "host", chainId: 84532 } as LaunchpadAdapter<
        LaunchDraft,
        never
      >,
      connectWallet: async () => address,
      signIdentity: async () => "wallet-signature",
      buildOpenIntent: (intent) => intent,
      depositProvider: () => provider,
    });
    const onSubmitted = vi.fn();

    await runtime.prepareIdentity();
    await runtime.deposit(3_000_000n, undefined, onSubmitted);

    expect(depositToPrivateBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 3_000_000n,
        onBurned: onSubmitted,
      }),
    );
  });
});
