import {
  decodeFunctionData,
  encodeFunctionData,
  type Address,
  type PublicClient,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { erc20Abi } from "@private-launchpad/sdk";
import {
  BaseSepoliaV4QuoteService,
  ClankerQuoteService,
  clankerQuoteServiceFromEnv,
} from "./clanker-quotes.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const USDC = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const UNISWAP_PROXY = "0x4444444444444444444444444444444444444444" as Address;
const LOCKER = "0x5555555555555555555555555555555555555555" as Address;
const HOOK = "0x6666666666666666666666666666666666666666" as Address;
const SWAP_HELPER = "0x7777777777777777777777777777777777777777" as Address;

it("does not initialize the legacy Clanker quote service on Robinhood", () => {
  expect(clankerQuoteServiceFromEnv({}, 4663)).toBeUndefined();
});

function response(value: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function fixture(outputRecipient = ACCOUNT) {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/check_approval")) {
      return response({
        requestId: "approval-1",
        cancel: null,
        approval: {
          to: USDC,
          from: ACCOUNT,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [UNISWAP_PROXY, 25_000_000n],
          }),
          value: "0",
          chainId: 8453,
        },
      });
    }
    if (url.endsWith("/quote")) {
      return response({
        requestId: "quote-1",
        routing: "CLASSIC",
        permitData: null,
        permitTransaction: null,
        quote: {
          input: { token: USDC, amount: "25000000" },
          output: {
            token: TOKEN,
            amount: "2000000000000000000",
            minimumAmount: "1900000000000000000",
            recipient: outputRecipient,
          },
        },
      });
    }
    if (url.endsWith("/swap")) {
      return response({
        requestId: "swap-1",
        swap: {
          to: UNISWAP_PROXY,
          from: ACCOUNT,
          data: "0x1234",
          value: "0",
          chainId: 8453,
        },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  });
  return {
    fetcher,
    service: new ClankerQuoteService({
      chainId: 8453,
      usdc: USDC,
      uniswapProxy: UNISWAP_PROXY,
      apiKey: "test-key",
      fetch: fetcher as typeof fetch,
    }),
  };
}

describe("Clanker quote service", () => {
  it("returns a bounded approve and AMM swap batch", async () => {
    const { service, fetcher } = fixture();
    const quote = await service.quote({
      chainId: 8453,
      account: ACCOUNT,
      usdc: USDC,
      token: TOKEN,
      side: "buy",
      amountIn: "25000000",
      slippageBps: 100,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(quote.requestId).toBe("quote-1");
    expect(quote.amountOut).toBe(2_000_000_000_000_000_000n);
    expect(quote.calls).toHaveLength(2);
    expect(quote.calls[0]?.target).toBe(USDC);
    expect(quote.calls[1]?.target).toBe(UNISWAP_PROXY);

    const quoteRequest = JSON.parse(
      String(fetcher.mock.calls[1]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(quoteRequest.tokenInChainId).toBe("8453");
    expect(quoteRequest.tokenOutChainId).toBe("8453");

    const swapRequest = JSON.parse(
      String(fetcher.mock.calls[2]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(swapRequest).toMatchObject({
      requestId: "quote-1",
      routing: "CLASSIC",
    });
    expect(swapRequest).not.toHaveProperty("permitData");
    expect(swapRequest).not.toHaveProperty("permitTransaction");
  });

  it("rejects output redirected away from the private account", async () => {
    const { service } = fixture("0x5555555555555555555555555555555555555555");
    await expect(
      service.quote({
        chainId: 8453,
        account: ACCOUNT,
        usdc: USDC,
        token: TOKEN,
        side: "buy",
        amountIn: "25000000",
        slippageBps: 100,
      }),
    ).rejects.toThrow(/assets do not match/);
  });
});

describe("Base Sepolia direct V4 quote service", () => {
  function v4Fixture(currency0 = USDC, currency1 = TOKEN) {
    const readContract = vi
      .fn()
      .mockResolvedValueOnce([TOKEN, HOOK, LOCKER])
      .mockResolvedValueOnce({
        token: TOKEN,
        poolKey: {
          currency0,
          currency1,
          fee: 8_388_608,
          tickSpacing: 200,
          hooks: HOOK,
        },
        positionId: 1n,
        numPositions: 1n,
        rewardBps: [10_000],
        rewardAdmins: [ACCOUNT],
        rewardRecipients: [ACCOUNT],
      });
    const simulateContract = vi.fn().mockResolvedValue({
      result: [2_000_000_000_000_000_000n, 250_000n],
    });
    const publicClient = {
      readContract,
      simulateContract,
    } as unknown as PublicClient;
    return {
      readContract,
      simulateContract,
      service: new BaseSepoliaV4QuoteService({
        publicClient,
        usdc: USDC,
        swapHelper: SWAP_HELPER,
      }),
    };
  }

  it("discovers the canonical Clanker pool and builds a bounded helper swap", async () => {
    const { service, readContract, simulateContract } = v4Fixture();
    const quote = await service.quote({
      chainId: 84532,
      account: ACCOUNT,
      usdc: USDC,
      token: TOKEN,
      side: "buy",
      amountIn: "25000000",
      slippageBps: 100,
    });

    expect(readContract).toHaveBeenCalledTimes(2);
    expect(simulateContract).toHaveBeenCalledOnce();
    expect(quote.amountOut).toBe(2_000_000_000_000_000_000n);
    expect(quote.minimumAmountOut).toBe(1_980_000_000_000_000_000n);
    expect(quote.calls).toHaveLength(2);
    expect(quote.calls[0]?.target).toBe(USDC);
    expect(quote.calls[1]?.target).toBe(SWAP_HELPER);

    const approval = decodeFunctionData({
      abi: erc20Abi,
      data: quote.calls[0]!.data,
    });
    expect(approval.functionName).toBe("approve");
    expect(approval.args).toEqual([SWAP_HELPER, 25_000_000n]);
  });

  it("reverses the same pool for a full-position sell", async () => {
    const { service, simulateContract } = v4Fixture();
    const quote = await service.quote({
      chainId: 84532,
      account: ACCOUNT,
      usdc: USDC,
      token: TOKEN,
      side: "sell",
      amountIn: "2000000000000000000",
      slippageBps: 100,
    });

    expect(quote.calls[0]?.target).toBe(TOKEN);
    expect(simulateContract.mock.calls[0]?.[0]).toMatchObject({
      args: [{ zeroForOne: false }],
    });
  });

  it("rejects old WETH-paired test tokens instead of inventing a route", async () => {
    const weth = "0x4200000000000000000000000000000000000006" as Address;
    const { service } = v4Fixture(weth, TOKEN);
    await expect(
      service.quote({
        chainId: 84532,
        account: ACCOUNT,
        usdc: USDC,
        token: TOKEN,
        side: "buy",
        amountIn: "25000000",
        slippageBps: 100,
      }),
    ).rejects.toThrow(/not paired with USDC/);
  });

  it("waits through Clanker's short post-launch auction window", async () => {
    const { service, simulateContract } = v4Fixture();
    service.config.quoteRetryAttempts = 3;
    service.config.quoteRetryDelayMs = 0;
    simulateContract
      .mockReset()
      .mockRejectedValueOnce(new Error("UnexpectedRevertBytes 0x6190b2b0"))
      .mockRejectedValueOnce(new Error("NotAuctionBlock"))
      .mockResolvedValueOnce({
        result: [2_000_000_000_000_000_000n, 250_000n],
      });

    const quote = await service.quote({
      chainId: 84532,
      account: ACCOUNT,
      usdc: USDC,
      token: TOKEN,
      side: "buy",
      amountIn: "25000000",
      slippageBps: 100,
    });

    expect(simulateContract).toHaveBeenCalledTimes(3);
    expect(quote.amountOut).toBe(2_000_000_000_000_000_000n);
  });
});
