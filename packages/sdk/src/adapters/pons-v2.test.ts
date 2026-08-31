import {
  decodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { erc20Abi } from "../abi.js";
import { PONS_V2_ROBINHOOD } from "../chains/robinhood.js";
import {
  buyMinimumFromQuote,
  constantProductAmountIn,
  constantProductAmountOut,
  ponsV2Adapter,
  ponsV2CurveAbi,
  ponsV2FactoryAbi,
  quotePonsV2Buy,
} from "./pons-v2.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x2222222222222222222222222222222222222222" as Address;
const CURVE = "0x3333333333333333333333333333333333333333" as Address;
const DIGEST = `0x${"44".repeat(32)}` as Hex;
const LAUNCH_RECORD = {
  token: TOKEN,
  curve: CURVE,
  deployer: ACCOUNT,
  creatorFeeRecipient: ACCOUNT,
  pairToken: PONS_V2_ROBINHOOD.usdg,
  graduationThreshold: 8_090_000_000n,
  poolFee: 0,
  tickSpacing: 200,
  creatorTaxBps: 100,
  buybackEnabled: false,
  phase: 0,
  sweptQuote: 0n,
  sweptTokens: 0n,
  sweptAt: 0n,
  exists: true,
} as const;

function publicClient(overrides: Record<string, unknown> = {}): PublicClient {
  const values: Record<string, unknown> = {
    canLaunch: true,
    launchFee: 500_000_000_000_000n,
    maxCreatorTaxBps: 1_000n,
    getLaunchConfig: {
      supply: 1_000_000_000n * 10n ** 18n,
      curveFeeBps: 100n,
      phantomQuote: 3_236_000_000n,
      graduationThreshold: 8_090_000_000n,
      poolFee: 0,
      tickSpacing: 200,
      enabled: true,
    },
    approvedPairTokens: true,
    previewLaunchEconomics: DIGEST,
    getLaunchedToken: LAUNCH_RECORD,
    token: TOKEN,
    pairToken: PONS_V2_ROBINHOOD.usdg,
    factory: PONS_V2_ROBINHOOD.factory,
    readyToGraduate: false,
    getReserves: [3_236_000_000n, 1_000_000_000n * 10n ** 18n],
    sellableTokens: 714_285_714n * 10n ** 18n,
    feeBps: 100n,
    creatorTaxBps: 100n,
    currentSnipeTaxBps: 0n,
    ...overrides,
  };
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (!(functionName in values)) {
        throw new Error(`unexpected Pons read: ${functionName}`);
      }
      return values[functionName];
    }),
  } as unknown as PublicClient;
}

describe("Pons V2 launch adapter", () => {
  it("pins live economics and forces creator roles onto the private account", async () => {
    const adapter = ponsV2Adapter();
    const [call] = await adapter.buildLaunchCalls(
      {
        name: "Private Pons",
        symbol: "PPONS",
        description: "Public metadata, private creator provenance",
        creatorTaxBps: 125,
        buybackEnabled: true,
        salt: `0x${"55".repeat(32)}`,
      },
      { account: ACCOUNT, publicClient: publicClient() },
    );

    expect(call?.target).toBe(PONS_V2_ROBINHOOD.factory);
    expect(call?.value).toBe(500_000_000_000_000n);
    const decoded = decodeFunctionData({
      abi: ponsV2FactoryAbi,
      data: call!.data,
    });
    expect(decoded.functionName).toBe("launchToken");
    const [params, configId, pairToken] = decoded.args;
    expect(params.creatorFeeRecipient).toBe(ACCOUNT);
    expect(params.expectedEconomics).toBe(DIGEST);
    expect(params.creatorTaxBps).toBe(125);
    expect(configId).toBe(0n);
    expect(pairToken).toBe(PONS_V2_ROBINHOOD.usdg);
  });

  it("fails closed when the live launch gate or USDG approval changes", async () => {
    const adapter = ponsV2Adapter();
    const intent = {
      name: "Private Pons",
      symbol: "PPONS",
      salt: `0x${"55".repeat(32)}` as const,
    };
    await expect(
      adapter.buildLaunchCalls(intent, {
        account: ACCOUNT,
        publicClient: publicClient({ canLaunch: false }),
      }),
    ).rejects.toThrow(/launching is closed/);
    await expect(
      adapter.buildLaunchCalls(intent, {
        account: ACCOUNT,
        publicClient: publicClient({ approvedPairTokens: false }),
      }),
    ).rejects.toThrow(/USDG pair is not approved/);
  });

  it("checks Pons's UTF-8 byte limits before making live reads", async () => {
    const client = publicClient();
    await expect(
      ponsV2Adapter().buildLaunchCalls(
        {
          name: "🦊".repeat(17),
          symbol: "FOX",
          salt: `0x${"55".repeat(32)}`,
        },
        { account: ACCOUNT, publicClient: client },
      ),
    ).rejects.toThrow(/name must be 1-64 UTF-8 bytes/);
    expect(client.readContract).not.toHaveBeenCalled();
  });
});

describe("Pons V2 curve adapter", () => {
  it("builds an exact USDG approval and account-bound buy", async () => {
    const calls = await ponsV2Adapter().buildOpenCalls(
      { token: TOKEN, curve: CURVE, quoteIn: 100_000_000n, slippageBps: 100 },
      { account: ACCOUNT, publicClient: publicClient() },
    );
    const approval = decodeFunctionData({
      abi: erc20Abi,
      data: calls[0]!.data,
    });
    expect(calls[0]?.target).toBe(PONS_V2_ROBINHOOD.usdg);
    expect(approval.functionName).toBe("approve");
    expect(approval.args).toEqual([CURVE, 100_000_000n]);

    const buy = decodeFunctionData({
      abi: ponsV2CurveAbi,
      data: calls[1]!.data,
    });
    expect(calls[1]?.target).toBe(CURVE);
    expect(calls[1]?.value).toBe(0n);
    expect(buy.functionName).toBe("buy");
    expect(buy.args[0]).toBe(100_000_000n);
    expect(buy.args[1]).toBeGreaterThan(0n);
    expect(buy.args[2]).toBe(ACCOUNT);
  });

  it("builds an exact token approval and account-bound sell", async () => {
    const calls = await ponsV2Adapter().buildCloseCalls(
      { token: TOKEN, curve: CURVE, tokensIn: 10n ** 18n, slippageBps: 50 },
      { account: ACCOUNT, publicClient: publicClient() },
    );
    const approval = decodeFunctionData({
      abi: erc20Abi,
      data: calls[0]!.data,
    });
    expect(calls[0]?.target).toBe(TOKEN);
    expect(approval.args).toEqual([CURVE, 10n ** 18n]);
    const sell = decodeFunctionData({
      abi: ponsV2CurveAbi,
      data: calls[1]!.data,
    });
    expect(sell.functionName).toBe("sell");
    expect(sell.args[2]).toBe(ACCOUNT);
  });

  it("rejects a graduated record or a mismatched dynamic curve", async () => {
    await expect(
      ponsV2Adapter().buildOpenCalls(
        { token: TOKEN, curve: CURVE, quoteIn: 1_000_000n, slippageBps: 100 },
        {
          account: ACCOUNT,
          publicClient: publicClient({
            getLaunchedToken: { ...LAUNCH_RECORD, phase: 2 },
          }),
        },
      ),
    ).rejects.toThrow(/phase 2/);

    await expect(
      ponsV2Adapter().buildOpenCalls(
        { token: TOKEN, curve: CURVE, quoteIn: 1_000_000n, slippageBps: 100 },
        {
          account: ACCOUNT,
          publicClient: publicClient({
            getLaunchedToken: {
              ...LAUNCH_RECORD,
              curve: "0x4444444444444444444444444444444444444444",
            },
          }),
        },
      ),
    ).rejects.toThrow(/curve does not belong/);
  });
});

describe("Pons V2 quote math", () => {
  it("matches the documented constant-product integer order", () => {
    expect(constantProductAmountOut(100n, 1_000n, 10_000n)).toBe(909n);
    expect(constantProductAmountIn(909n, 1_000n, 10_000n)).toBe(100n);
  });

  it("caps launch-window tax so at least one percent remains", async () => {
    const quote = await quotePonsV2Buy(
      publicClient({ currentSnipeTaxBps: 9_900n }),
      CURVE,
      100_000_000n,
      ACCOUNT,
    );
    expect(quote.effectiveSnipeTaxBps).toBe(9_700n);
    expect(quote.tokensOut).toBeGreaterThan(0n);
  });

  it("normalizes a partial-fill minimum by its quoted rate", () => {
    expect(
      buyMinimumFromQuote({ tokensOut: 100n, spent: 50n }, 100n, 100),
    ).toBe(198n);
  });
});
