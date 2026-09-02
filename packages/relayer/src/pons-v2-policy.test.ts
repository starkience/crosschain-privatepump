import {
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  NO_RELAYER_FEE,
  PONS_V2_ROBINHOOD,
  approveCall,
  erc20Abi,
  ponsV2CurveAbi,
  ponsV2FactoryAbi,
  type RelayExecutionRequest,
} from "@private-launchpad/sdk";
import { createPonsV2SemanticValidator } from "./pons-v2-policy.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const OWNER = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const CURVE = "0x4444444444444444444444444444444444444444" as Address;
const ACCOUNT_FACTORY = "0x5555555555555555555555555555555555555555" as Address;
const DIGEST = `0x${"66".repeat(32)}` as Hex;
const RELAY_REQUEST_ID = `0x${"88".repeat(32)}`;

const LAUNCH_RECORD = {
  token: TOKEN,
  curve: CURVE,
  deployer: ACCOUNT,
  creatorFeeRecipient: ACCOUNT,
  pairToken: PONS_V2_ROBINHOOD.usdg,
  graduationThreshold: 8_090_000_000n,
  poolFee: 0,
  tickSpacing: 200,
  creatorTaxBps: 0,
  buybackEnabled: false,
  phase: 0,
  sweptQuote: 0n,
  sweptTokens: 0n,
  sweptAt: 0n,
  exists: true,
} as const;

function client(overrides: Record<string, unknown> = {}): PublicClient {
  const reads: Record<string, unknown> = {
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
    token: TOKEN,
    pairToken: PONS_V2_ROBINHOOD.usdg,
    factory: PONS_V2_ROBINHOOD.factory,
    readyToGraduate: false,
    getLaunchedToken: LAUNCH_RECORD,
    getReserves: [3_236_000_000n, 1_000_000_000n * 10n ** 18n],
    sellableTokens: 714_285_714n * 10n ** 18n,
    feeBps: 100n,
    creatorTaxBps: 0n,
    currentSnipeTaxBps: 0n,
    ...overrides,
  };
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (!(functionName in reads))
        throw new Error(`unexpected read ${functionName}`);
      return reads[functionName];
    }),
  } as unknown as PublicClient;
}

function request(calls: RelayExecutionRequest["calls"]): RelayExecutionRequest {
  return {
    chainId: 4663,
    factory: ACCOUNT_FACTORY,
    account: ACCOUNT,
    owner: OWNER,
    accountIndex: 1,
    calls,
    nonce: 0n,
    deadline: 1_900_000_000n,
    prefund: calls.reduce((total, call) => total + call.value, 0n),
    fee: NO_RELAYER_FEE,
    signature: "0x" as Hex,
  };
}

function launchCall(recipient = ACCOUNT) {
  return {
    target: PONS_V2_ROBINHOOD.factory,
    value: 500_000_000_000_000n,
    data: encodeFunctionData({
      abi: ponsV2FactoryAbi,
      functionName: "launchToken",
      args: [
        {
          name: "Private Pons",
          symbol: "PPONS",
          logo: "",
          description: "",
          socials: {
            twitter: "",
            telegram: "",
            discord: "",
            website: "",
            farcaster: "",
          },
          creatorFeeRecipient: recipient,
          creatorTaxBps: 0,
          buybackEnabled: false,
          expectedEconomics: DIGEST,
          salt: `0x${"77".repeat(32)}` as Hex,
        },
        0n,
        PONS_V2_ROBINHOOD.usdg,
      ],
    }),
  } as const;
}

function buyCalls(
  recipient = ACCOUNT,
  minTokensOut = 20_000_000n * 10n ** 18n,
) {
  const quoteIn = 100_000_000n;
  return [
    approveCall(PONS_V2_ROBINHOOD.usdg, CURVE, quoteIn),
    {
      target: CURVE,
      value: 0n,
      data: encodeFunctionData({
        abi: ponsV2CurveAbi,
        functionName: "buy",
        args: [quoteIn, minTokensOut, recipient],
      }),
    },
  ] as const;
}

describe("Pons V2 relayer semantic policy", () => {
  const validate = createPonsV2SemanticValidator();

  it("accepts a live economics-pinned, account-attributed launch", async () => {
    await expect(
      validate(request([launchCall()]), client()),
    ).resolves.toBeUndefined();
  });

  it("rejects a launch that leaks creator fees to another address", async () => {
    await expect(
      validate(request([launchCall(OWNER)]), client()),
    ).rejects.toThrow(/creator fee recipient/);
  });

  it("rejects a stale launch economics digest", async () => {
    await expect(
      validate(
        request([launchCall()]),
        client({ previewLaunchEconomics: `0x${"88".repeat(32)}` }),
      ),
    ).rejects.toThrow(/digest is stale/);
  });

  it("rejects a launch prefund that does not exactly fund the live fee", async () => {
    await expect(
      validate({ ...request([launchCall()]), prefund: 0n }, client()),
    ).rejects.toThrow(/prefund must equal/);
  });

  it("accepts an exact USDG approval and account-bound curve buy", async () => {
    await expect(
      validate(request(buyCalls()), client()),
    ).resolves.toBeUndefined();
  });

  it("rejects a buy recipient outside the execution account", async () => {
    await expect(validate(request(buyCalls(OWNER)), client())).rejects.toThrow(
      /buy recipient/,
    );
  });

  it("rejects a trade minimum outside the maximum slippage policy", async () => {
    await expect(
      validate(request(buyCalls(ACCOUNT, 1n)), client()),
    ).rejects.toThrow(/maximum slippage policy/);
  });

  it("rejects a dynamic curve not recorded as an active launch", async () => {
    await expect(
      validate(
        request(buyCalls()),
        client({ getLaunchedToken: { ...LAUNCH_RECORD, phase: 2 } }),
      ),
    ).rejects.toThrow(/active factory-recorded/);
  });

  it("accepts an exact launch-token approval and account-bound sell", async () => {
    const tokensIn = 10n ** 18n;
    const calls = [
      approveCall(TOKEN, CURVE, tokensIn),
      {
        target: CURVE,
        value: 0n,
        data: encodeFunctionData({
          abi: ponsV2CurveAbi,
          functionName: "sell",
          args: [tokensIn, 1n, ACCOUNT],
        }),
      },
    ] as const;
    await expect(validate(request(calls), client())).resolves.toBeUndefined();
    await expect(
      validate(request(calls), client({ readyToGraduate: true })),
    ).rejects.toThrow(/ready to graduate/);
  });

  it("accepts an owner-signed USDG transfer into a private return route", async () => {
    const verifyRelayReturn = vi.fn(async () => undefined);
    const validateReturn = createPonsV2SemanticValidator(
      PONS_V2_ROBINHOOD,
      verifyRelayReturn,
    );
    const call = {
      target: PONS_V2_ROBINHOOD.usdg,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [CURVE, 25_000_000n],
      }),
    } as const;
    await expect(
      validateReturn(
        {
          ...request([call]),
          relayRequestId: RELAY_REQUEST_ID,
          relayQuoteAttestation: "v1.payload.signature",
        },
        client(),
      ),
    ).resolves.toBeUndefined();
    expect(verifyRelayReturn).toHaveBeenCalledWith({
      requestId: RELAY_REQUEST_ID,
      quoteAttestation: "v1.payload.signature",
      account: ACCOUNT,
      owner: OWNER,
      depositAddress: CURVE,
      amount: 25_000_000n,
    });
  });

  it("rejects a private return without independently verifiable Relay binding", async () => {
    const call = {
      target: PONS_V2_ROBINHOOD.usdg,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [CURVE, 25_000_000n],
      }),
    } as const;
    await expect(validate(request([call]), client())).rejects.toThrow(
      /requires a Relay request ID/,
    );
  });
});
