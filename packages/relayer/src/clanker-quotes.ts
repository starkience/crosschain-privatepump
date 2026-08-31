import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { randomUUID } from "node:crypto";
import {
  erc20Abi,
  type ClankerTradeQuote,
  type ClankerTradeQuoteRequest,
  type ClankerTradeSide,
  type ExecutionCall,
} from "@private-launchpad/sdk";

const DEFAULT_UNISWAP_API = "https://trade-api.gateway.uniswap.org/v1";
const BASE_SEPOLIA_CLANKER_V4_FACTORY =
  "0xE85A59c628F7d27878ACeB4bf3b35733630083a9" as Address;
const BASE_SEPOLIA_V4_QUOTER =
  "0x4A6513c898fe1B2d0E78d3b0e0A4a151589B1cBa" as Address;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_UINT128 = (1n << 128n) - 1n;

export interface ClankerQuoteProvider {
  quote(value: unknown): Promise<ClankerTradeQuote>;
}

const clankerFactoryPoolAbi = [
  {
    type: "function",
    name: "deploymentInfoForToken",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "token", type: "address" },
      { name: "hook", type: "address" },
      { name: "locker", type: "address" },
    ],
  },
] as const;

const clankerLockerPoolAbi = [
  {
    type: "function",
    name: "tokenRewards",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "rewardInfo",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "positionId", type: "uint256" },
          { name: "numPositions", type: "uint256" },
          { name: "rewardBps", type: "uint16[]" },
          { name: "rewardAdmins", type: "address[]" },
          { name: "rewardRecipients", type: "address[]" },
        ],
      },
    ],
  },
] as const;

const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const v4SwapHelperAbi = [
  {
    type: "function",
    name: "swapExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "minimumAmountOut", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

interface ApiTransaction {
  to: Address;
  from: Address;
  data: Hex;
  value: bigint;
  chainId: number;
}

export interface ClankerQuoteServiceConfig {
  chainId: 8453 | 84532;
  usdc: Address;
  uniswapProxy: Address;
  apiKey: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  quoteLifetimeSeconds?: number;
}

export class ClankerQuoteService {
  readonly config: ClankerQuoteServiceConfig;
  readonly fetcher: typeof fetch;

  constructor(config: ClankerQuoteServiceConfig) {
    if (!config.apiKey.trim()) throw new Error("Uniswap API key is required");
    this.config = config;
    this.fetcher = config.fetch ?? globalThis.fetch;
    if (!this.fetcher) throw new Error("fetch is unavailable");
  }

  async quote(value: unknown): Promise<ClankerTradeQuote> {
    const request = parseClankerTradeQuoteRequest(value);
    if (request.chainId !== this.config.chainId) throw new Error("wrong chain");
    if (getAddress(request.usdc) !== getAddress(this.config.usdc)) {
      throw new Error("wrong USDC token");
    }
    if (getAddress(request.token) === getAddress(request.usdc)) {
      throw new Error("Clanker token and USDC must differ");
    }

    const tokenIn = request.side === "buy" ? request.usdc : request.token;
    const tokenOut = request.side === "buy" ? request.token : request.usdc;
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": this.config.apiKey,
      "x-permit2-disabled": "true",
      "x-universal-router-version": "2.0",
    };
    const approvalResponse = await this.post("/check_approval", headers, {
      walletAddress: request.account,
      token: tokenIn,
      amount: request.amountIn.toString(),
      chainId: request.chainId,
      tokenOut,
      tokenOutChainId: request.chainId,
    });
    const quoteResponse = await this.post("/quote", headers, {
      type: "EXACT_INPUT",
      amount: request.amountIn.toString(),
      tokenInChainId: String(request.chainId),
      tokenOutChainId: String(request.chainId),
      tokenIn,
      tokenOut,
      swapper: request.account,
      recipient: request.account,
      slippageTolerance: request.slippageBps / 100,
      routingPreference: "BEST_PRICE",
      protocols: ["V2", "V3", "V4"],
    });
    if (quoteResponse.routing !== "CLASSIC") {
      throw new Error("Uniswap returned a non-AMM route");
    }
    if (!record(quoteResponse.quote)) {
      throw new Error("Uniswap quote payload is missing");
    }
    const swapRequest = { ...quoteResponse };
    delete swapRequest.permitData;
    delete swapRequest.permitTransaction;
    const swapResponse = await this.post("/swap", headers, {
      ...swapRequest,
      simulateTransaction: false,
      deadline:
        Math.floor(Date.now() / 1000) +
        (this.config.quoteLifetimeSeconds ?? 120),
    });

    const calls: ExecutionCall[] = [];
    for (const field of ["cancel", "approval"] as const) {
      const transaction = optionalTransaction(approvalResponse[field], field);
      if (!transaction) continue;
      validateApproval(
        transaction,
        request,
        tokenIn,
        this.config.uniswapProxy,
        field === "cancel",
      );
      calls.push(toCall(transaction));
    }
    const swap = apiTransaction(swapResponse.swap, "swap");
    validateTransactionEnvelope(swap, request, "swap");
    if (getAddress(swap.to) !== getAddress(this.config.uniswapProxy)) {
      throw new Error("Uniswap swap target is not the approved proxy");
    }
    calls.push(toCall(swap));

    const quote = quoteResponse.quote;
    const input = record(quote.input) ? quote.input : undefined;
    const output = record(quote.output) ? quote.output : undefined;
    if (
      !input ||
      !output ||
      address(input.token, "quote.input.token") !== getAddress(tokenIn) ||
      address(output.token, "quote.output.token") !== getAddress(tokenOut) ||
      address(output.recipient, "quote.output.recipient") !==
        getAddress(request.account) ||
      uint(input.amount, "quote.input.amount") !== request.amountIn
    ) {
      throw new Error("Uniswap quote assets do not match the request");
    }
    const amountOut = uint(output.amount, "quote.output.amount");
    const minimumAmountOut = uint(
      output.minimumAmount,
      "quote.output.minimumAmount",
    );
    return {
      ...request,
      requestId: string(quoteResponse.requestId, "requestId"),
      amountOut,
      minimumAmountOut,
      expiresAt:
        Math.floor(Date.now() / 1000) +
        (this.config.quoteLifetimeSeconds ?? 120),
      calls,
    };
  }

  private async post(
    path: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetcher(
      `${this.config.apiUrl ?? DEFAULT_UNISWAP_API}${path}`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    const value: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        record(value) && typeof value.detail === "string"
          ? value.detail
          : `Uniswap ${path} returned ${response.status}`;
      throw new Error(message);
    }
    if (!record(value))
      throw new Error(`Uniswap ${path} returned invalid JSON`);
    return value;
  }
}

export interface BaseSepoliaV4QuoteServiceConfig {
  publicClient: PublicClient;
  usdc: Address;
  swapHelper: Address;
  clankerFactory?: Address;
  v4Quoter?: Address;
  quoteLifetimeSeconds?: number;
  quoteRetryAttempts?: number;
  quoteRetryDelayMs?: number;
}

/**
 * Base Sepolia fallback for Clanker pools. Uniswap's hosted Trading API does
 * not route this testnet, so the relayer reads Clanker's canonical PoolKey and
 * quotes against the deployed V4Quoter. Execution is constrained to Plank's
 * exact-input helper, which always returns output to the calling private account.
 */
export class BaseSepoliaV4QuoteService implements ClankerQuoteProvider {
  constructor(readonly config: BaseSepoliaV4QuoteServiceConfig) {}

  async quote(value: unknown): Promise<ClankerTradeQuote> {
    const request = parseClankerTradeQuoteRequest(value);
    if (request.chainId !== 84532) throw new Error("wrong chain");
    if (getAddress(request.usdc) !== getAddress(this.config.usdc)) {
      throw new Error("wrong USDC token");
    }
    if (request.amountIn > MAX_UINT128) {
      throw new Error("amountIn exceeds the V4 exact-input limit");
    }

    const factory =
      this.config.clankerFactory ?? BASE_SEPOLIA_CLANKER_V4_FACTORY;
    const deployment = await this.config.publicClient.readContract({
      address: factory,
      abi: clankerFactoryPoolAbi,
      functionName: "deploymentInfoForToken",
      args: [request.token],
    });
    const [deployedToken, _hook, locker] = deployment;
    if (
      getAddress(deployedToken) !== getAddress(request.token) ||
      getAddress(locker) === ZERO_ADDRESS
    ) {
      throw new Error("token is not a live Clanker V4 deployment");
    }

    const rewardInfo = await this.config.publicClient.readContract({
      address: locker,
      abi: clankerLockerPoolAbi,
      functionName: "tokenRewards",
      args: [request.token],
    });
    if (getAddress(rewardInfo.token) !== getAddress(request.token)) {
      throw new Error("Clanker locker returned the wrong token");
    }
    const poolKey = {
      currency0: getAddress(rewardInfo.poolKey.currency0),
      currency1: getAddress(rewardInfo.poolKey.currency1),
      fee: rewardInfo.poolKey.fee,
      tickSpacing: rewardInfo.poolKey.tickSpacing,
      hooks: getAddress(rewardInfo.poolKey.hooks),
    };
    const currencies = new Set([
      poolKey.currency0.toLowerCase(),
      poolKey.currency1.toLowerCase(),
    ]);
    if (
      !currencies.has(request.token.toLowerCase()) ||
      !currencies.has(request.usdc.toLowerCase())
    ) {
      throw new Error(
        "This testnet token is not paired with USDC. Launch a new Plank token to trade privately.",
      );
    }

    const tokenIn = request.side === "buy" ? request.usdc : request.token;
    const tokenOut = request.side === "buy" ? request.token : request.usdc;
    const zeroForOne =
      getAddress(tokenIn) === getAddress(poolKey.currency0) &&
      getAddress(tokenOut) === getAddress(poolKey.currency1);
    if (
      !zeroForOne &&
      !(
        getAddress(tokenIn) === getAddress(poolKey.currency1) &&
        getAddress(tokenOut) === getAddress(poolKey.currency0)
      )
    ) {
      throw new Error("Clanker pool direction does not match the trade");
    }
    const hookData = "0x" as Hex;
    const quoteSimulation = await this.simulateV4Quote(request, {
      poolKey,
      zeroForOne,
      exactAmount: request.amountIn,
      hookData,
    });
    const [amountOut] = quoteSimulation.result;
    const minimumAmountOut =
      (amountOut * BigInt(10_000 - request.slippageBps)) / 10_000n;
    if (amountOut === 0n || minimumAmountOut === 0n) {
      throw new Error("Clanker V4 pool returned no output");
    }
    if (minimumAmountOut > MAX_UINT128) {
      throw new Error("minimum output exceeds the V4 helper limit");
    }

    const approval: ExecutionCall = {
      target: getAddress(tokenIn),
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [this.config.swapHelper, request.amountIn],
      }),
    };
    const swap: ExecutionCall = {
      target: getAddress(this.config.swapHelper),
      value: 0n,
      data: encodeFunctionData({
        abi: v4SwapHelperAbi,
        functionName: "swapExactInputSingle",
        args: [
          poolKey,
          zeroForOne,
          request.amountIn,
          minimumAmountOut,
          hookData,
        ],
      }),
    };
    const lifetime = this.config.quoteLifetimeSeconds ?? 120;
    return {
      ...request,
      requestId: `base-sepolia-v4:${randomUUID()}`,
      amountOut,
      minimumAmountOut,
      expiresAt: Math.floor(Date.now() / 1000) + lifetime,
      calls: [approval, swap],
    };
  }

  private async simulateV4Quote(
    request: ClankerTradeQuoteRequest,
    params: {
      poolKey: {
        currency0: Address;
        currency1: Address;
        fee: number;
        tickSpacing: number;
        hooks: Address;
      };
      zeroForOne: boolean;
      exactAmount: bigint;
      hookData: Hex;
    },
  ) {
    const attempts = this.config.quoteRetryAttempts ?? 8;
    const retryDelayMs = this.config.quoteRetryDelayMs ?? 2_000;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.config.publicClient.simulateContract({
          account: request.account,
          address: this.config.v4Quoter ?? BASE_SEPOLIA_V4_QUOTER,
          abi: v4QuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [params],
        });
      } catch (error) {
        lastError = error;
        if (!isClankerAuctionWarmup(error) || attempt + 1 >= attempts) break;
        await delay(retryDelayMs);
      }
    }
    if (isClankerAuctionWarmup(lastError)) {
      throw new Error(
        "Clanker launch protection is still active. Wait a few seconds and retry.",
      );
    }
    throw lastError;
  }
}

export function clankerQuoteServiceFromEnv(
  env: NodeJS.ProcessEnv,
  chainId: number,
  publicClient?: PublicClient,
): ClankerQuoteProvider | undefined {
  if (chainId !== 8453 && chainId !== 84532) {
    // This is an optional compatibility service. Non-Base launchpads (Pons
    // on Robinhood, for example) provide their own quote implementation.
    return undefined;
  }
  if (chainId === 84532) {
    if (!publicClient) {
      throw new Error("Base Sepolia V4 quotes require a public client");
    }
    if (!env.BASE_SEPOLIA_V4_SWAP_HELPER_ADDRESS) return undefined;
    return new BaseSepoliaV4QuoteService({
      publicClient,
      usdc: address(env.USDC_ADDRESS, "USDC_ADDRESS"),
      swapHelper: address(
        env.BASE_SEPOLIA_V4_SWAP_HELPER_ADDRESS,
        "BASE_SEPOLIA_V4_SWAP_HELPER_ADDRESS",
      ),
      ...(env.CLANKER_V4_FACTORY_ADDRESS
        ? {
            clankerFactory: address(
              env.CLANKER_V4_FACTORY_ADDRESS,
              "CLANKER_V4_FACTORY_ADDRESS",
            ),
          }
        : {}),
      ...(env.BASE_SEPOLIA_V4_QUOTER_ADDRESS
        ? {
            v4Quoter: address(
              env.BASE_SEPOLIA_V4_QUOTER_ADDRESS,
              "BASE_SEPOLIA_V4_QUOTER_ADDRESS",
            ),
          }
        : {}),
    });
  }
  if (!env.UNISWAP_API_KEY) return undefined;
  return new ClankerQuoteService({
    chainId,
    usdc: address(env.USDC_ADDRESS, "USDC_ADDRESS"),
    uniswapProxy: address(env.UNISWAP_PROXY_ADDRESS, "UNISWAP_PROXY_ADDRESS"),
    apiKey: env.UNISWAP_API_KEY,
    ...(env.UNISWAP_API_URL ? { apiUrl: env.UNISWAP_API_URL } : {}),
  });
}

export function tradeQuoteJson(
  quote: ClankerTradeQuote,
): Record<string, unknown> {
  return {
    ...quote,
    amountIn: quote.amountIn.toString(),
    amountOut: quote.amountOut.toString(),
    minimumAmountOut: quote.minimumAmountOut.toString(),
    calls: quote.calls.map((call) => ({
      ...call,
      value: call.value.toString(),
    })),
  };
}

function parseClankerTradeQuoteRequest(
  value: unknown,
): ClankerTradeQuoteRequest {
  if (!record(value)) throw new Error("trade quote request must be an object");
  return {
    chainId: safeInteger(value.chainId, "chainId"),
    account: address(value.account, "account"),
    usdc: address(value.usdc, "usdc"),
    token: address(value.token, "token"),
    side: side(value.side),
    amountIn: uint(value.amountIn, "amountIn"),
    slippageBps: boundedInteger(value.slippageBps, "slippageBps", 1, 5_000),
  };
}

function validateApproval(
  transaction: ApiTransaction,
  request: ClankerTradeQuoteRequest,
  tokenIn: Address,
  proxy: Address,
  cancellation: boolean,
): void {
  validateTransactionEnvelope(transaction, request, "approval");
  if (getAddress(transaction.to) !== getAddress(tokenIn)) {
    throw new Error("Uniswap approval targets the wrong input token");
  }
  if (transaction.value !== 0n) throw new Error("approval cannot send ETH");
  const decoded = decodeFunctionData({ abi: erc20Abi, data: transaction.data });
  if (decoded.functionName !== "approve") {
    throw new Error("Uniswap approval calldata is not approve");
  }
  const [spender, amount] = decoded.args;
  if (getAddress(spender) !== getAddress(proxy)) {
    throw new Error("Uniswap approval has the wrong spender");
  }
  if (cancellation ? amount !== 0n : amount < request.amountIn) {
    throw new Error("Uniswap approval amount is insufficient");
  }
}

function validateTransactionEnvelope(
  transaction: ApiTransaction,
  request: ClankerTradeQuoteRequest,
  field: string,
): void {
  if (transaction.chainId !== request.chainId) {
    throw new Error(`Uniswap ${field} has the wrong chain`);
  }
  if (getAddress(transaction.from) !== getAddress(request.account)) {
    throw new Error(`Uniswap ${field} has the wrong sender`);
  }
}

function toCall(transaction: ApiTransaction): ExecutionCall {
  return {
    target: transaction.to,
    value: transaction.value,
    data: transaction.data,
  };
}

function optionalTransaction(
  value: unknown,
  field: string,
): ApiTransaction | undefined {
  return value === null || value === undefined
    ? undefined
    : apiTransaction(value, field);
}

function apiTransaction(value: unknown, field: string): ApiTransaction {
  if (!record(value)) throw new Error(`Uniswap ${field} is missing`);
  return {
    to: address(value.to, `${field}.to`),
    from: address(value.from, `${field}.from`),
    data: hex(value.data, `${field}.data`),
    value: uint(value.value, `${field}.value`),
    chainId: safeInteger(value.chainId, `${field}.chainId`),
  };
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

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = safeInteger(value, field);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function side(value: unknown): ClankerTradeSide {
  if (value !== "buy" && value !== "sell") {
    throw new Error("side must be buy or sell");
  }
  return value;
}

function isClankerAuctionWarmup(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const value = current as {
      message?: unknown;
      shortMessage?: unknown;
      raw?: unknown;
      signature?: unknown;
      cause?: unknown;
    };
    const text = [value.message, value.shortMessage, value.raw, value.signature]
      .filter((item): item is string => typeof item === "string")
      .join(" ");
    if (
      /0x6190b2b0|UnexpectedRevertBytes|NotAuctionBlock|HookCallFailed/i.test(
        text,
      )
    ) {
      return true;
    }
    current = value.cause;
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
