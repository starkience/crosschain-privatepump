import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  type Address,
  type PublicClient,
} from "viem";
import { approveCall } from "../adapters.js";
import {
  PONS_V2_ROBINHOOD,
  ROBINHOOD_MAINNET_CHAIN_ID,
  type PonsV2Deployment,
} from "../chains/robinhood.js";
import type {
  AdapterContext,
  ExecutionCall,
  LaunchpadAdapter,
} from "../types.js";

const BPS = 10_000n;
const MIN_BUY_NET_BPS = 100n;

export const ponsV2FactoryAbi = [
  {
    type: "event",
    name: "TokenLaunched",
    anonymous: false,
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "curve", type: "address" },
      { indexed: true, name: "deployer", type: "address" },
      { indexed: false, name: "pairToken", type: "address" },
      { indexed: false, name: "launchConfigId", type: "uint256" },
      { indexed: false, name: "graduationThreshold", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "canLaunch",
    stateMutability: "view",
    inputs: [{ name: "launcher", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "launchFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxCreatorTaxBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approvedPairTokens",
    stateMutability: "view",
    inputs: [{ name: "pairToken", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getLaunchConfig",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "supply", type: "uint256" },
          { name: "curveFeeBps", type: "uint256" },
          { name: "phantomQuote", type: "uint256" },
          { name: "graduationThreshold", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "enabled", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "previewLaunchEconomics",
    stateMutability: "view",
    inputs: [
      { name: "launchConfigId", type: "uint256" },
      { name: "pairToken", type: "address" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getLaunchedToken",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "curve", type: "address" },
          { name: "deployer", type: "address" },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "pairToken", type: "address" },
          { name: "graduationThreshold", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "phase", type: "uint8" },
          { name: "sweptQuote", type: "uint256" },
          { name: "sweptTokens", type: "uint256" },
          { name: "sweptAt", type: "uint256" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "launchToken",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "logo", type: "string" },
          { name: "description", type: "string" },
          {
            name: "socials",
            type: "tuple",
            components: [
              { name: "twitter", type: "string" },
              { name: "telegram", type: "string" },
              { name: "discord", type: "string" },
              { name: "website", type: "string" },
              { name: "farcaster", type: "string" },
            ],
          },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "expectedEconomics", type: "bytes32" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "launchConfigId", type: "uint256" },
      { name: "pairToken", type: "address" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "curve", type: "address" },
    ],
  },
] as const;

export const ponsV2CurveAbi = [
  {
    type: "function",
    name: "buy",
    stateMutability: "payable",
    inputs: [
      { name: "quoteIn", type: "uint256" },
      { name: "minTokensOut", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "tokensOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokensIn", type: "uint256" },
      { name: "minQuoteOut", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "quoteOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "getReserves",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "quoteReserve", type: "uint256" },
      { name: "tokenReserve", type: "uint256" },
    ],
  },
  ...["sellableTokens", "feeBps", "creatorTaxBps"].map((name) => ({
    type: "function" as const,
    name,
    stateMutability: "view" as const,
    inputs: [] as const,
    outputs: [{ name: "", type: "uint256" }] as const,
  })),
  {
    type: "function",
    name: "currentSnipeTaxBps",
    stateMutability: "view",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  ...["token", "pairToken", "factory"].map((name) => ({
    type: "function" as const,
    name,
    stateMutability: "view" as const,
    inputs: [] as const,
    outputs: [{ name: "", type: "address" }] as const,
  })),
  {
    type: "function",
    name: "readyToGraduate",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface PonsV2Socials {
  twitter?: string;
  telegram?: string;
  discord?: string;
  website?: string;
  farcaster?: string;
}

export interface PonsV2LaunchIntent {
  name: string;
  symbol: string;
  logo?: string;
  description?: string;
  socials?: PonsV2Socials;
  creatorTaxBps?: number;
  buybackEnabled?: boolean;
  launchConfigId?: bigint;
  salt: `0x${string}`;
}

export interface PonsV2BuyIntent {
  token: Address;
  curve: Address;
  quoteIn: bigint;
  slippageBps: number;
}

export interface PonsV2SellIntent {
  token: Address;
  curve: Address;
  tokensIn: bigint;
  slippageBps: number;
}

export interface PonsV2BuyQuote {
  tokensOut: bigint;
  spent: bigint;
  refund: bigint;
  effectiveSnipeTaxBps: bigint;
}

export interface PonsV2Adapter extends LaunchpadAdapter<
  PonsV2BuyIntent,
  PonsV2SellIntent
> {
  readonly deployment: PonsV2Deployment;
  buildLaunchCalls(
    intent: PonsV2LaunchIntent,
    context: AdapterContext,
  ): Promise<readonly ExecutionCall[]>;
}

export function ponsV2Adapter(
  deployment: PonsV2Deployment = PONS_V2_ROBINHOOD,
): PonsV2Adapter {
  if (deployment.chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
    throw new Error("Pons V2 is not configured on this Robinhood chain");
  }
  return {
    id: "pons-v2",
    chainId: deployment.chainId,
    deployment,
    async buildLaunchCalls(intent, context) {
      return buildPonsV2LaunchCalls(intent, context, deployment);
    },
    async buildOpenCalls(intent, context) {
      const launch = await validateLiveCurve(
        intent.token,
        intent.curve,
        context.publicClient,
        deployment,
      );
      if (!launch.exists) throw new Error("Pons token does not exist");
      const quote = await quotePonsV2Buy(
        context.publicClient,
        intent.curve,
        intent.quoteIn,
        context.account,
      );
      const minTokensOut = buyMinimumFromQuote(
        quote,
        intent.quoteIn,
        intent.slippageBps,
      );
      return [
        approveCall(deployment.usdg, intent.curve, intent.quoteIn),
        {
          target: getAddress(intent.curve),
          value: 0n,
          data: encodeFunctionData({
            abi: ponsV2CurveAbi,
            functionName: "buy",
            args: [intent.quoteIn, minTokensOut, context.account],
          }),
        },
      ];
    },
    async buildCloseCalls(intent, context) {
      await validateLiveCurve(
        intent.token,
        intent.curve,
        context.publicClient,
        deployment,
        true,
      );
      const quoteOut = await quotePonsV2Sell(
        context.publicClient,
        intent.curve,
        intent.tokensIn,
      );
      const minQuoteOut = applySlippage(quoteOut, intent.slippageBps);
      return [
        approveCall(intent.token, intent.curve, intent.tokensIn),
        {
          target: getAddress(intent.curve),
          value: 0n,
          data: encodeFunctionData({
            abi: ponsV2CurveAbi,
            functionName: "sell",
            args: [intent.tokensIn, minQuoteOut, context.account],
          }),
        },
      ];
    },
  };
}

export async function buildPonsV2LaunchCalls(
  intent: PonsV2LaunchIntent,
  context: AdapterContext,
  deployment: PonsV2Deployment = PONS_V2_ROBINHOOD,
): Promise<readonly ExecutionCall[]> {
  validateLaunchIntent(intent);
  const creatorTaxBps = intent.creatorTaxBps ?? 0;
  const launchConfigId = intent.launchConfigId ?? 0n;
  const [canLaunch, launchFee, maxCreatorTaxBps, config, pairApproved, digest] =
    await Promise.all([
      context.publicClient.readContract({
        address: deployment.factory,
        abi: ponsV2FactoryAbi,
        functionName: "canLaunch",
        args: [context.account],
      }),
      context.publicClient.readContract({
        address: deployment.factory,
        abi: ponsV2FactoryAbi,
        functionName: "launchFee",
      }),
      context.publicClient.readContract({
        address: deployment.factory,
        abi: ponsV2FactoryAbi,
        functionName: "maxCreatorTaxBps",
      }),
      context.publicClient.readContract({
        address: deployment.factory,
        abi: ponsV2FactoryAbi,
        functionName: "getLaunchConfig",
        args: [launchConfigId],
      }),
      context.publicClient.readContract({
        address: deployment.factory,
        abi: ponsV2FactoryAbi,
        functionName: "approvedPairTokens",
        args: [deployment.usdg],
      }),
      context.publicClient.readContract({
        address: deployment.factory,
        abi: ponsV2FactoryAbi,
        functionName: "previewLaunchEconomics",
        args: [launchConfigId, deployment.usdg],
      }),
    ]);
  if (!canLaunch) throw new Error("Pons launching is closed for this account");
  if (!config.enabled) throw new Error("Pons launch config is disabled");
  if (!pairApproved) throw new Error("Pons USDG pair is not approved");
  if (digest === `0x${"00".repeat(32)}`) {
    throw new Error("Pons launch economics digest is unavailable");
  }
  if (BigInt(creatorTaxBps) > maxCreatorTaxBps) {
    throw new Error("Pons creator tax exceeds the current factory maximum");
  }
  const socials = intent.socials ?? {};
  return [
    {
      target: deployment.factory,
      value: launchFee,
      data: encodeFunctionData({
        abi: ponsV2FactoryAbi,
        functionName: "launchToken",
        args: [
          {
            name: intent.name.trim(),
            symbol: intent.symbol.trim(),
            logo: intent.logo ?? "",
            description: intent.description ?? "",
            socials: {
              twitter: socials.twitter ?? "",
              telegram: socials.telegram ?? "",
              discord: socials.discord ?? "",
              website: socials.website ?? "",
              farcaster: socials.farcaster ?? "",
            },
            creatorFeeRecipient: context.account,
            creatorTaxBps,
            buybackEnabled: intent.buybackEnabled ?? false,
            expectedEconomics: digest,
            salt: intent.salt,
          },
          launchConfigId,
          deployment.usdg,
        ],
      }),
    },
  ];
}

export async function quotePonsV2Buy(
  publicClient: PublicClient,
  curve: Address,
  quoteIn: bigint,
  recipient: Address,
): Promise<PonsV2BuyQuote> {
  if (quoteIn <= 0n) throw new Error("Pons buy amount must be positive");
  const [reserves, sellable, feeBps, creatorTaxBps, rawSnipeTaxBps] =
    await Promise.all([
      readCurve(publicClient, curve, "getReserves"),
      readCurve(publicClient, curve, "sellableTokens"),
      readCurve(publicClient, curve, "feeBps"),
      readCurve(publicClient, curve, "creatorTaxBps"),
      publicClient.readContract({
        address: curve,
        abi: ponsV2CurveAbi,
        functionName: "currentSnipeTaxBps",
        args: [recipient],
      }),
    ]);
  const [quoteReserve, tokenReserve] = reserves as readonly [bigint, bigint];
  const sellableTokens = sellable as bigint;
  const baseFeeBps = feeBps as bigint;
  const taxBps = creatorTaxBps as bigint;
  const maxSnipeTaxBps = BPS - baseFeeBps - taxBps - MIN_BUY_NET_BPS;
  if (maxSnipeTaxBps < 0n) throw new Error("Pons curve fee state is invalid");
  const snipeTaxBps =
    rawSnipeTaxBps > maxSnipeTaxBps ? maxSnipeTaxBps : rawSnipeTaxBps;
  const totalFeeBps = baseFeeBps + taxBps + snipeTaxBps;
  if (totalFeeBps >= BPS) throw new Error("Pons curve fee is not quotable");

  let spent = quoteIn;
  const netInput =
    spent -
    (spent * baseFeeBps) / BPS -
    (spent * taxBps) / BPS -
    (spent * snipeTaxBps) / BPS;
  let tokensOut = constantProductAmountOut(
    netInput,
    quoteReserve,
    tokenReserve,
  );
  if (tokensOut > sellableTokens) {
    tokensOut = sellableTokens;
    const net = constantProductAmountIn(
      sellableTokens,
      quoteReserve,
      tokenReserve,
    );
    const grossed = ceilDiv(net * BPS, BPS - totalFeeBps);
    spent = grossed < quoteIn ? grossed : quoteIn;
  }
  if (tokensOut <= 0n) throw new Error("Pons buy has no output");
  return {
    tokensOut,
    spent,
    refund: quoteIn - spent,
    effectiveSnipeTaxBps: snipeTaxBps,
  };
}

export async function quotePonsV2Sell(
  publicClient: PublicClient,
  curve: Address,
  tokensIn: bigint,
): Promise<bigint> {
  if (tokensIn <= 0n) throw new Error("Pons sell amount must be positive");
  const [ready, reserves, feeBps, creatorTaxBps] = await Promise.all([
    publicClient.readContract({
      address: curve,
      abi: ponsV2CurveAbi,
      functionName: "readyToGraduate",
    }),
    readCurve(publicClient, curve, "getReserves"),
    readCurve(publicClient, curve, "feeBps"),
    readCurve(publicClient, curve, "creatorTaxBps"),
  ]);
  if (ready) throw new Error("Pons curve is ready to graduate");
  const [quoteReserve, tokenReserve] = reserves as readonly [bigint, bigint];
  const gross = constantProductAmountOut(tokensIn, tokenReserve, quoteReserve);
  const output =
    gross -
    (gross * (feeBps as bigint)) / BPS -
    (gross * (creatorTaxBps as bigint)) / BPS;
  if (output <= 0n) throw new Error("Pons sell has no output");
  return output;
}

export function constantProductAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  if (amountIn <= 0n) throw new Error("Pons quote input must be positive");
  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw new Error("Pons curve has insufficient liquidity");
  }
  const output = (amountIn * reserveOut) / (reserveIn + amountIn);
  if (output <= 0n) throw new Error("Pons quote output rounds to zero");
  return output;
}

export function constantProductAmountIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  if (amountOut <= 0n || reserveIn <= 0n || reserveOut <= amountOut) {
    throw new Error("Pons exact output is not quotable");
  }
  return (amountOut * reserveIn) / (reserveOut - amountOut) + 1n;
}

export function buyMinimumFromQuote(
  quote: Pick<PonsV2BuyQuote, "tokensOut" | "spent">,
  requestedQuoteIn: bigint,
  slippageBps: number,
): bigint {
  if (quote.spent <= 0n || requestedQuoteIn <= 0n) {
    throw new Error("Pons buy quote is invalid");
  }
  // The curve scales minTokensOut by spent/requested input on a partial fill.
  // Convert the quoted partial output back to the full-input rate first.
  const rateNormalized = (quote.tokensOut * requestedQuoteIn) / quote.spent;
  return applySlippage(rateNormalized, slippageBps);
}

export function applySlippage(amount: bigint, slippageBps: number): bigint {
  validateSlippage(slippageBps);
  const minimum = (amount * BigInt(10_000 - slippageBps)) / BPS;
  if (minimum <= 0n) throw new Error("Pons minimum output rounds to zero");
  return minimum;
}

async function validateLiveCurve(
  token: Address,
  curve: Address,
  publicClient: PublicClient,
  deployment: PonsV2Deployment,
  selling = false,
) {
  const normalizedToken = getAddress(token);
  const normalizedCurve = getAddress(curve);
  const [launch, curveToken, curvePair, curveFactory, ready] =
    await Promise.all([
      publicClient.readContract({
        address: deployment.factory,
        abi: ponsV2FactoryAbi,
        functionName: "getLaunchedToken",
        args: [normalizedToken],
      }),
      readCurve(publicClient, normalizedCurve, "token"),
      readCurve(publicClient, normalizedCurve, "pairToken"),
      readCurve(publicClient, normalizedCurve, "factory"),
      selling
        ? publicClient.readContract({
            address: normalizedCurve,
            abi: ponsV2CurveAbi,
            functionName: "readyToGraduate",
          })
        : Promise.resolve(false),
    ]);
  if (!launch.exists) throw new Error("Pons token is not registered");
  if (launch.phase !== 0) {
    throw new Error(
      `Pons token is not on its bonding curve (phase ${launch.phase})`,
    );
  }
  if (!isAddressEqual(launch.token, normalizedToken)) {
    throw new Error("Pons launch record token mismatch");
  }
  if (
    !isAddressEqual(launch.curve, normalizedCurve) ||
    !isAddressEqual(curveToken as Address, normalizedToken)
  ) {
    throw new Error("Pons curve does not belong to this token");
  }
  if (
    !isAddressEqual(launch.pairToken, deployment.usdg) ||
    !isAddressEqual(curvePair as Address, deployment.usdg)
  ) {
    throw new Error("Pons launch is not quoted in the configured USDG");
  }
  if (!isAddressEqual(curveFactory as Address, deployment.factory)) {
    throw new Error("Pons curve belongs to an unexpected factory");
  }
  if (ready) throw new Error("Pons curve is ready to graduate");
  return launch;
}

function readCurve(
  publicClient: PublicClient,
  curve: Address,
  functionName: string,
): Promise<unknown> {
  return publicClient.readContract({
    address: curve,
    abi: ponsV2CurveAbi,
    functionName,
  } as never);
}

function validateLaunchIntent(intent: PonsV2LaunchIntent): void {
  const encoder = new TextEncoder();
  validateText("name", intent.name.trim(), 1, 64, encoder);
  validateText("symbol", intent.symbol.trim(), 1, 16, encoder);
  validateText("logo", intent.logo ?? "", 0, 512, encoder);
  validateText("description", intent.description ?? "", 0, 2_048, encoder);
  for (const [name, value] of Object.entries(intent.socials ?? {})) {
    validateText(`social ${name}`, value ?? "", 0, 256, encoder);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(intent.salt)) {
    throw new Error("Pons launch salt must be bytes32");
  }
  const tax = intent.creatorTaxBps ?? 0;
  if (!Number.isSafeInteger(tax) || tax < 0 || tax > 10_000) {
    throw new Error("Pons creator tax must be an integer from 0 to 10000 bps");
  }
  if ((intent.launchConfigId ?? 0n) < 0n) {
    throw new Error("Pons launch config id must be non-negative");
  }
}

function validateText(
  name: string,
  value: string,
  minimum: number,
  maximum: number,
  encoder: TextEncoder,
): void {
  const bytes = encoder.encode(value).length;
  if (bytes < minimum || bytes > maximum) {
    throw new Error(`Pons ${name} must be ${minimum}-${maximum} UTF-8 bytes`);
  }
}

function validateSlippage(slippageBps: number): void {
  if (
    !Number.isSafeInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 5_000
  ) {
    throw new Error("Pons slippage must be an integer from 0 to 5000 bps");
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Pons quote denominator is invalid");
  return (numerator + denominator - 1n) / denominator;
}
