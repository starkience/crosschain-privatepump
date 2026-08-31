import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import type {
  AdapterContext,
  ExecutionCall,
  LaunchpadAdapter,
} from "../types.js";

export type ClankerTradeSide = "buy" | "sell";

export interface ClankerTradeIntent {
  token: Address;
  amountIn: bigint;
  slippageBps?: number;
}

export interface ClankerTradeQuoteRequest extends Omit<
  ClankerTradeIntent,
  "slippageBps"
> {
  chainId: number;
  account: Address;
  usdc: Address;
  side: ClankerTradeSide;
  slippageBps: number;
}

export interface ClankerTradeQuote extends ClankerTradeQuoteRequest {
  requestId: string;
  amountOut: bigint;
  minimumAmountOut: bigint;
  expiresAt: number;
  calls: readonly ExecutionCall[];
}

export interface ClankerTradeQuoteProvider {
  getQuote(request: ClankerTradeQuoteRequest): Promise<ClankerTradeQuote>;
}

export interface ClankerTradeAdapter extends LaunchpadAdapter<
  ClankerTradeIntent,
  ClankerTradeIntent
> {
  /** Returns the validated quote that will be executed by buildOpen/CloseCalls. */
  quote(
    side: ClankerTradeSide,
    intent: ClankerTradeIntent,
    context: AdapterContext,
  ): Promise<ClankerTradeQuote>;
}

export interface HttpClankerTradeQuoteProviderConfig {
  endpoint: string;
  fetch?: typeof fetch;
}

/** Browser transport for the same-origin, server-keyed Uniswap quote route. */
export function createHttpClankerTradeQuoteProvider(
  config: HttpClankerTradeQuoteProviderConfig,
): ClankerTradeQuoteProvider {
  if (!config.endpoint.trim()) throw new Error("quote endpoint is required");
  const fetcher = config.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("fetch is unavailable");
  return {
    async getQuote(request) {
      const response = await fetcher(config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...request,
          amountIn: request.amountIn.toString(),
        }),
        credentials: "same-origin",
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          record(body) && typeof body.error === "string"
            ? body.error
            : `quote service returned ${response.status}`;
        throw new Error(message);
      }
      return parseClankerTradeQuote(body);
    },
  };
}

/** Buy and sell Clanker tokens through server-prepared Uniswap AMM calls. */
export function clankerTradeAdapter(
  chainId: 8453 | 84532,
  usdc: Address,
  provider: ClankerTradeQuoteProvider,
): ClankerTradeAdapter {
  const quote = async (
    side: ClankerTradeSide,
    intent: ClankerTradeIntent,
    context: AdapterContext,
  ): Promise<ClankerTradeQuote> => {
    validateIntent(intent);
    const request: ClankerTradeQuoteRequest = {
      ...intent,
      slippageBps: intent.slippageBps ?? 100,
      chainId,
      account: context.account,
      usdc,
      side,
    };
    const result = await provider.getQuote(request);
    validateQuote(result, request);
    return result;
  };
  return {
    id: "clanker-uniswap",
    chainId,
    quote,
    buildOpenCalls: async (intent, context) =>
      (await quote("buy", intent, context)).calls,
    buildCloseCalls: async (intent, context) =>
      (await quote("sell", intent, context)).calls,
  };
}

export function parseClankerTradeQuote(value: unknown): ClankerTradeQuote {
  if (!record(value)) throw new Error("trade quote must be an object");
  const callsValue = value.calls;
  if (!Array.isArray(callsValue) || callsValue.length === 0) {
    throw new Error("trade quote calls must be a non-empty array");
  }
  return {
    requestId: string(value.requestId, "requestId"),
    chainId: safeInteger(value.chainId, "chainId"),
    account: address(value.account, "account"),
    usdc: address(value.usdc, "usdc"),
    token: address(value.token, "token"),
    side: side(value.side),
    amountIn: uint(value.amountIn, "amountIn"),
    slippageBps: safeInteger(value.slippageBps, "slippageBps"),
    amountOut: uint(value.amountOut, "amountOut"),
    minimumAmountOut: uint(value.minimumAmountOut, "minimumAmountOut"),
    expiresAt: safeInteger(value.expiresAt, "expiresAt"),
    calls: callsValue.map((raw, index) => {
      if (!record(raw)) throw new Error(`calls[${index}] must be an object`);
      return {
        target: address(raw.target, `calls[${index}].target`),
        value: uint(raw.value, `calls[${index}].value`),
        data: hex(raw.data, `calls[${index}].data`),
      };
    }),
  };
}

function validateIntent(intent: ClankerTradeIntent): void {
  if (intent.amountIn <= 0n) throw new Error("trade amount must be positive");
  const slippage = intent.slippageBps ?? 100;
  if (!Number.isSafeInteger(slippage) || slippage < 1 || slippage > 5_000) {
    throw new Error("slippage must be an integer from 1 to 5000 bps");
  }
}

function validateQuote(
  quote: ClankerTradeQuote,
  request: ClankerTradeQuoteRequest,
): void {
  for (const field of ["account", "usdc", "token"] as const) {
    if (getAddress(quote[field]) !== getAddress(request[field])) {
      throw new Error(`trade quote ${field} does not match the request`);
    }
  }
  if (
    quote.chainId !== request.chainId ||
    quote.side !== request.side ||
    quote.amountIn !== request.amountIn ||
    quote.slippageBps !== request.slippageBps
  ) {
    throw new Error("trade quote does not match the request");
  }
  if (quote.amountOut <= 0n || quote.minimumAmountOut > quote.amountOut) {
    throw new Error("trade quote output is invalid");
  }
  if (quote.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error("trade quote expired");
  }
  for (const [index, call] of quote.calls.entries()) {
    if (call.target === "0x0000000000000000000000000000000000000000") {
      throw new Error(`trade quote call ${index} has a zero target`);
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw new Error(`${field} must be an EVM address`);
  }
  return getAddress(value);
}

function hex(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !isHex(value)) {
    throw new Error(`${field} must be hex`);
  }
  return value;
}

function uint(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be an unsigned integer string`);
  }
  return BigInt(value);
}

function safeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function side(value: unknown): ClankerTradeSide {
  if (value !== "buy" && value !== "sell") {
    throw new Error("side must be buy or sell");
  }
  return value;
}
