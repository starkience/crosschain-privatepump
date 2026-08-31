import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  clankerTradeAdapter,
  createHttpClankerTradeQuoteProvider,
  type ClankerTradeQuote,
  type ClankerTradeQuoteRequest,
} from "./clanker-trade.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const USDC = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const TARGET = "0x4444444444444444444444444444444444444444" as Address;

function quote(request: ClankerTradeQuoteRequest): ClankerTradeQuote {
  return {
    ...request,
    requestId: "quote-1",
    amountOut: 2_000n,
    minimumAmountOut: 1_900n,
    expiresAt: Math.floor(Date.now() / 1000) + 120,
    calls: [{ target: TARGET, value: 0n, data: "0x1234" as Hex }],
  };
}

describe("Clanker Uniswap trade adapter", () => {
  it("binds buy quotes to the private position account", async () => {
    const getQuote = vi.fn(async (request: ClankerTradeQuoteRequest) =>
      quote(request),
    );
    const adapter = clankerTradeAdapter(8453, USDC, { getQuote });
    const calls = await adapter.buildOpenCalls(
      { token: TOKEN, amountIn: 25_000_000n },
      { account: ACCOUNT, publicClient: {} as never },
    );

    expect(getQuote).toHaveBeenCalledWith({
      token: TOKEN,
      amountIn: 25_000_000n,
      slippageBps: 100,
      chainId: 8453,
      account: ACCOUNT,
      usdc: USDC,
      side: "buy",
    });
    expect(calls).toEqual([{ target: TARGET, value: 0n, data: "0x1234" }]);
  });

  it("exposes validated output amounts for position accounting", async () => {
    const adapter = clankerTradeAdapter(84532, USDC, {
      getQuote: async (request) => quote(request),
    });
    const result = await adapter.quote(
      "sell",
      { token: TOKEN, amountIn: 1_240n, slippageBps: 100 },
      { account: ACCOUNT, publicClient: {} as never },
    );

    expect(result.amountIn).toBe(1_240n);
    expect(result.amountOut).toBe(2_000n);
    expect(result.minimumAmountOut).toBe(1_900n);
    expect(result.side).toBe("sell");
  });

  it("rejects a quote for another account", async () => {
    const adapter = clankerTradeAdapter(8453, USDC, {
      getQuote: async (request) => ({
        ...quote(request),
        account: "0x5555555555555555555555555555555555555555",
      }),
    });
    await expect(
      adapter.buildCloseCalls(
        { token: TOKEN, amountIn: 1n },
        { account: ACCOUNT, publicClient: {} as never },
      ),
    ).rejects.toThrow(/account does not match/);
  });

  it("serializes bigint quote requests and parses calls", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          ...request,
          requestId: "quote-http",
          amountOut: "2000",
          minimumAmountOut: "1900",
          expiresAt: Math.floor(Date.now() / 1000) + 120,
          calls: [{ target: TARGET, value: "0", data: "0x1234" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = createHttpClankerTradeQuoteProvider({
      endpoint: "/v1/clanker/quote",
      fetch: fetcher as typeof fetch,
    });
    const result = await provider.getQuote({
      chainId: 8453,
      account: ACCOUNT,
      usdc: USDC,
      token: TOKEN,
      side: "buy",
      amountIn: 25_000_000n,
      slippageBps: 100,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.amountIn).toBe(25_000_000n);
    expect(result.amountOut).toBe(2_000n);
  });
});
