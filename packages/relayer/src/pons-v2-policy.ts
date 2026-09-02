import {
  decodeFunctionData,
  getAddress,
  isAddressEqual,
  type Address,
  type PublicClient,
} from "viem";
import {
  applySlippage,
  buyMinimumFromQuote,
  erc20Abi,
  PONS_V2_ROBINHOOD,
  ponsV2CurveAbi,
  ponsV2FactoryAbi,
  quotePonsV2Buy,
  quotePonsV2Sell,
  type PonsV2Deployment,
  type RelayExecutionRequest,
} from "@private-launchpad/sdk";
import type { SemanticCallValidator } from "./relayer.js";
import type { RelayReturnVerifier } from "./relay-requests.js";

const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const MAX_SLIPPAGE_BPS = 5_000;

/**
 * Validates the complete call shape rather than trusting a static list of
 * targets. Pons creates a new token and curve per launch, so their relationship
 * has to be proved from the factory record at relay time.
 */
export function createPonsV2SemanticValidator(
  deployment: PonsV2Deployment = PONS_V2_ROBINHOOD,
  relayReturnVerifier?: RelayReturnVerifier,
): SemanticCallValidator {
  return async (request, publicClient) => {
    if (request.chainId !== deployment.chainId) {
      throw new Error("Pons policy received the wrong chain");
    }
    if (
      request.calls.length === 1 &&
      isAddressEqual(request.calls[0]!.target, deployment.factory)
    ) {
      await validateLaunch(request, publicClient, deployment);
      return;
    }
    if (
      request.calls.length === 1 &&
      isAddressEqual(request.calls[0]!.target, deployment.usdg)
    ) {
      await validatePrivateReturnTransfer(request, relayReturnVerifier);
      return;
    }
    if (request.calls.length === 2) {
      await validateCurveTrade(request, publicClient, deployment);
      return;
    }
    throw new Error(
      "Pons policy only permits launch, curve trades, or an owner-signed USDG return transfer",
    );
  };
}

async function validatePrivateReturnTransfer(
  request: RelayExecutionRequest,
  relayReturnVerifier: RelayReturnVerifier | undefined,
): Promise<void> {
  const call = request.calls[0]!;
  if (call.value !== 0n || request.prefund !== 0n) {
    throw new Error(
      "Pons private return must not send or prefund native value",
    );
  }
  let decoded: ReturnType<typeof decodeFunctionData<typeof erc20Abi>>;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
  } catch {
    throw new Error("Pons private return calldata is not recognized");
  }
  if (decoded.functionName !== "transfer") {
    throw new Error("Pons single-call USDG action must be a transfer");
  }
  const [recipient, amount] = decoded.args;
  if (amount <= 0n)
    throw new Error("Pons private return amount must be positive");
  if (isAddressEqual(recipient, request.account)) {
    throw new Error(
      "Pons private return cannot transfer back to the same account",
    );
  }
  if (!request.relayRequestId) {
    throw new Error("Pons private return requires a Relay request ID");
  }
  if (!request.relayQuoteAttestation) {
    throw new Error("Pons private return requires a Relay quote attestation");
  }
  if (!relayReturnVerifier) {
    throw new Error("Pons private return verification is not configured");
  }
  await relayReturnVerifier({
    requestId: request.relayRequestId,
    quoteAttestation: request.relayQuoteAttestation,
    account: request.account,
    owner: request.owner,
    depositAddress: recipient,
    amount,
  });
}

async function validateLaunch(
  request: RelayExecutionRequest,
  publicClient: PublicClient,
  deployment: PonsV2Deployment,
): Promise<void> {
  const call = request.calls[0]!;
  let decoded: ReturnType<typeof decodeFunctionData<typeof ponsV2FactoryAbi>>;
  try {
    decoded = decodeFunctionData({ abi: ponsV2FactoryAbi, data: call.data });
  } catch {
    throw new Error("Pons launch calldata is not recognized");
  }
  if (decoded.functionName !== "launchToken") {
    throw new Error("Pons factory selector is not allowed");
  }
  const [params, configId, pairToken] = decoded.args;
  if (!isAddressEqual(pairToken, deployment.usdg)) {
    throw new Error("Pons launch pair must be configured USDG");
  }
  if (!isAddressEqual(params.creatorFeeRecipient, request.account)) {
    throw new Error("Pons creator fee recipient must be the execution account");
  }
  if (params.expectedEconomics === ZERO_BYTES32) {
    throw new Error("Pons launch economics must be pinned");
  }
  validateMetadata(params);

  const [
    canLaunch,
    launchFee,
    maxCreatorTaxBps,
    config,
    pairApproved,
    expectedEconomics,
  ] = await Promise.all([
    publicClient.readContract({
      address: deployment.factory,
      abi: ponsV2FactoryAbi,
      functionName: "canLaunch",
      args: [request.account],
    }),
    publicClient.readContract({
      address: deployment.factory,
      abi: ponsV2FactoryAbi,
      functionName: "launchFee",
    }),
    publicClient.readContract({
      address: deployment.factory,
      abi: ponsV2FactoryAbi,
      functionName: "maxCreatorTaxBps",
    }),
    publicClient.readContract({
      address: deployment.factory,
      abi: ponsV2FactoryAbi,
      functionName: "getLaunchConfig",
      args: [configId],
    }),
    publicClient.readContract({
      address: deployment.factory,
      abi: ponsV2FactoryAbi,
      functionName: "approvedPairTokens",
      args: [deployment.usdg],
    }),
    publicClient.readContract({
      address: deployment.factory,
      abi: ponsV2FactoryAbi,
      functionName: "previewLaunchEconomics",
      args: [configId, deployment.usdg],
    }),
  ]);
  if (!canLaunch) throw new Error("Pons launching is closed for this account");
  if (!config.enabled) throw new Error("Pons launch config is disabled");
  if (!pairApproved) throw new Error("Pons USDG pair is no longer approved");
  if (call.value !== launchFee)
    throw new Error("Pons launch value is not exact");
  if (request.prefund !== launchFee) {
    throw new Error("Pons launch prefund must equal the live launch fee");
  }
  if (BigInt(params.creatorTaxBps) > maxCreatorTaxBps) {
    throw new Error("Pons creator tax exceeds the live maximum");
  }
  if (params.expectedEconomics !== expectedEconomics) {
    throw new Error("Pons launch economics digest is stale");
  }
}

async function validateCurveTrade(
  request: RelayExecutionRequest,
  publicClient: PublicClient,
  deployment: PonsV2Deployment,
): Promise<void> {
  const [approvalCall, tradeCall] = request.calls;
  if (!approvalCall || !tradeCall)
    throw new Error("Pons trade batch is incomplete");
  if (approvalCall.value !== 0n || tradeCall.value !== 0n) {
    throw new Error("Pons USDG curve trades must not send native value");
  }
  if (request.prefund !== 0n) {
    throw new Error("Pons curve trades must not request a native prefund");
  }
  let approval: ReturnType<typeof decodeFunctionData<typeof erc20Abi>>;
  let trade: ReturnType<typeof decodeFunctionData<typeof ponsV2CurveAbi>>;
  try {
    approval = decodeFunctionData({ abi: erc20Abi, data: approvalCall.data });
    trade = decodeFunctionData({ abi: ponsV2CurveAbi, data: tradeCall.data });
  } catch {
    throw new Error("Pons trade calldata is not recognized");
  }
  if (approval.functionName !== "approve") {
    throw new Error("Pons trade must start with an exact approval");
  }
  if (trade.functionName !== "buy" && trade.functionName !== "sell") {
    throw new Error("Pons curve selector is not allowed");
  }
  const curve = getAddress(tradeCall.target);
  if (!isAddressEqual(approval.args[0], curve)) {
    throw new Error("Pons approval spender is not the traded curve");
  }

  const [curveToken, curvePair, curveFactory, ready] = await Promise.all([
    readCurveAddress(publicClient, curve, "token"),
    readCurveAddress(publicClient, curve, "pairToken"),
    readCurveAddress(publicClient, curve, "factory"),
    publicClient.readContract({
      address: curve,
      abi: ponsV2CurveAbi,
      functionName: "readyToGraduate",
    }),
  ]);
  if (!isAddressEqual(curveFactory, deployment.factory)) {
    throw new Error("Pons curve factory is not allowed");
  }
  if (!isAddressEqual(curvePair, deployment.usdg)) {
    throw new Error("Pons curve is not quoted in configured USDG");
  }
  const launch = await publicClient.readContract({
    address: deployment.factory,
    abi: ponsV2FactoryAbi,
    functionName: "getLaunchedToken",
    args: [curveToken],
  });
  if (
    !launch.exists ||
    launch.phase !== 0 ||
    !isAddressEqual(launch.token, curveToken) ||
    !isAddressEqual(launch.curve, curve) ||
    !isAddressEqual(launch.pairToken, deployment.usdg)
  ) {
    throw new Error("Pons curve is not an active factory-recorded USDG launch");
  }

  if (trade.functionName === "buy") {
    const [quoteIn, minTokensOut, recipient] = trade.args;
    if (!isAddressEqual(approvalCall.target, deployment.usdg)) {
      throw new Error("Pons buy approval target must be configured USDG");
    }
    if (approval.args[1] !== quoteIn || quoteIn <= 0n) {
      throw new Error("Pons buy approval amount is not exact");
    }
    if (minTokensOut <= 0n) throw new Error("Pons buy needs a minimum output");
    if (!isAddressEqual(recipient, request.account)) {
      throw new Error("Pons buy recipient must be the execution account");
    }
    const liveQuote = await quotePonsV2Buy(
      publicClient,
      curve,
      quoteIn,
      request.account,
    );
    const policyMinimum = buyMinimumFromQuote(
      liveQuote,
      quoteIn,
      MAX_SLIPPAGE_BPS,
    );
    if (minTokensOut < policyMinimum) {
      throw new Error("Pons buy minimum exceeds the maximum slippage policy");
    }
    return;
  }

  const [tokensIn, minQuoteOut, recipient] = trade.args;
  if (ready) throw new Error("Pons curve is ready to graduate");
  if (!isAddressEqual(approvalCall.target, curveToken)) {
    throw new Error("Pons sell approval target must be the launch token");
  }
  if (approval.args[1] !== tokensIn || tokensIn <= 0n) {
    throw new Error("Pons sell approval amount is not exact");
  }
  if (minQuoteOut <= 0n) throw new Error("Pons sell needs a minimum output");
  if (!isAddressEqual(recipient, request.account)) {
    throw new Error("Pons sell recipient must be the execution account");
  }
  const policyMinimum = applySlippage(
    await quotePonsV2Sell(publicClient, curve, tokensIn),
    MAX_SLIPPAGE_BPS,
  );
  if (minQuoteOut < policyMinimum) {
    throw new Error("Pons sell minimum exceeds the maximum slippage policy");
  }
}

async function readCurveAddress(
  publicClient: PublicClient,
  curve: Address,
  functionName: "token" | "pairToken" | "factory",
): Promise<Address> {
  return getAddress(
    (await publicClient.readContract({
      address: curve,
      abi: ponsV2CurveAbi,
      functionName,
    } as never)) as Address,
  );
}

function validateMetadata(params: {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: {
    twitter: string;
    telegram: string;
    discord: string;
    website: string;
    farcaster: string;
  };
}): void {
  const encoder = new TextEncoder();
  const lengths: readonly [string, string, number, number][] = [
    ["name", params.name, 1, 64],
    ["symbol", params.symbol, 1, 16],
    ["logo", params.logo, 0, 512],
    ["description", params.description, 0, 2_048],
    ["twitter", params.socials.twitter, 0, 256],
    ["telegram", params.socials.telegram, 0, 256],
    ["discord", params.socials.discord, 0, 256],
    ["website", params.socials.website, 0, 256],
    ["farcaster", params.socials.farcaster, 0, 256],
  ];
  for (const [name, value, minimum, maximum] of lengths) {
    const size = encoder.encode(value).length;
    if (size < minimum || size > maximum) {
      throw new Error(`Pons ${name} metadata is outside protocol bounds`);
    }
  }
}
