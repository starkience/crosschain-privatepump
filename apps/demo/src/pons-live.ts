import {
  PONS_V2_ROBINHOOD,
  ROBINHOOD_MAINNET_CHAIN_ID,
  applySlippage,
  buyMinimumFromQuote,
  ponsV2Adapter,
  ponsV2FactoryAbi,
  quotePonsV2Buy,
  quotePonsV2Sell,
  type Eip1193Provider,
  type LaunchpadAdapter,
  type PonsV2BuyIntent,
  type PonsV2LaunchIntent,
  type PonsV2SellIntent,
} from "@private-launchpad/sdk";
import {
  createWalletClient,
  custom,
  getAddress,
  isAddress,
  parseEventLogs,
  type Address,
} from "viem";
import { createPonsMainnetLiveClient } from "./live-client.js";
import {
  readPonsTokenMetadata,
  recoverPonsPositions,
} from "./pons-recovery.js";
import { createLiveRuntime, type LaunchpadRuntime } from "./runtime.js";

const ROBINHOOD_CHAIN_HEX = `0x${ROBINHOOD_MAINNET_CHAIN_ID.toString(16)}`;

export async function createPrivatePonsLiveRuntime(
  environment: Readonly<Record<string, unknown>>,
): Promise<LaunchpadRuntime> {
  const client = await createPonsMainnetLiveClient(environment);
  const pons = ponsV2Adapter();
  const launchAdapter: LaunchpadAdapter<PonsV2LaunchIntent, never> = {
    id: "pons-v2-launch",
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    buildOpenCalls: (intent, context) => pons.buildLaunchCalls(intent, context),
    buildCloseCalls: async () => {
      throw new Error("a Pons launch cannot be closed");
    },
  };

  return createLiveRuntime<
    PonsV2LaunchIntent,
    never,
    PonsV2BuyIntent | PonsV2SellIntent
  >({
    appId: "private-pons",
    networkName: "Robinhood Mainnet",
    accountIndex: randomAccountIndex,
    fastFunding: true,
    client,
    adapter: launchAdapter,
    connectWallet: async () => {
      const provider = injectedProvider();
      await ensureRobinhoodMainnet(provider);
      const accounts = await provider.request({
        method: "eth_requestAccounts",
      });
      if (!Array.isArray(accounts) || !isAddress(accounts[0])) {
        throw new Error("wallet did not return an EVM account");
      }
      return getAddress(accounts[0]);
    },
    signIdentity: async ({ address, message }) => {
      const wallet = createWalletClient({
        transport: custom(injectedProvider()),
      });
      return wallet.signMessage({ account: address, message });
    },
    depositProvider: () => injectedProvider(),
    readMarketMetadata: (token) =>
      readPonsTokenMetadata(client.config.publicClient, token),
    recoverPositions: ({ signature }) =>
      recoverPonsPositions({ client, signature }),
    buildOpenIntent: (draft) => ({
      name: draft.name,
      symbol: draft.symbol,
      ...(draft.description ? { description: draft.description } : {}),
      creatorTaxBps: creatorTaxFromLegacySlider(draft.creatorReward),
      buybackEnabled: false,
      salt: draft.salt,
    }),
    openOptions: async () => ({
      prefund: await client.config.publicClient.readContract({
        address: PONS_V2_ROBINHOOD.factory,
        abi: ponsV2FactoryAbi,
        functionName: "launchFee",
      }),
    }),
    resolveOpenTokenAfterExecution: async (
      transactionHash,
      _intent,
      session,
    ) => {
      const receipt =
        await client.config.publicClient.waitForTransactionReceipt({
          hash: transactionHash,
          confirmations: 1,
          timeout: 120_000,
        });
      if (receipt.status !== "success") throw new Error("Pons launch reverted");
      const events = parseEventLogs({
        abi: ponsV2FactoryAbi,
        eventName: "TokenLaunched",
        logs: receipt.logs,
        strict: true,
      });
      const event = events.find(
        (candidate) =>
          getAddress(candidate.address) === PONS_V2_ROBINHOOD.factory &&
          getAddress(candidate.args.deployer) === session.account,
      );
      if (!event)
        throw new Error(
          "Pons launch receipt did not contain this account's token",
        );
      return getAddress(event.args.token);
    },
    trade: {
      async buildIntent(draft) {
        const launch = await client.config.publicClient.readContract({
          address: PONS_V2_ROBINHOOD.factory,
          abi: ponsV2FactoryAbi,
          functionName: "getLaunchedToken",
          args: [getAddress(draft.token)],
        });
        if (!launch.exists) throw new Error("Pons token is not registered");
        if (launch.phase === 1) {
          throw new Error(
            "This Pons market has been swept and is no longer tradable on its bonding curve",
          );
        }
        if (launch.phase === 2) {
          throw new Error(
            "This Pons market has graduated to V4; private graduated-market trading is not available yet",
          );
        }
        if (launch.phase === 3) {
          throw new Error(
            "This Pons market was rescued and is no longer tradable on its bonding curve",
          );
        }
        if (launch.phase !== 0) {
          throw new Error(
            `This Pons market is in unsupported phase ${launch.phase}`,
          );
        }
        return {
          token: getAddress(draft.token),
          curve: getAddress(launch.curve),
          ...(draft.amountIn > 0n
            ? { quoteIn: draft.amountIn, tokensIn: draft.amountIn }
            : {}),
          slippageBps: draft.slippageBps,
        } as PonsV2BuyIntent | PonsV2SellIntent;
      },
      async quote(side, intent, session) {
        if (side === "buy") {
          const buy = intent as PonsV2BuyIntent;
          const quote = await quotePonsV2Buy(
            client.config.publicClient,
            buy.curve,
            buy.quoteIn,
            session.account,
          );
          return {
            amountIn: buy.quoteIn,
            amountOut: quote.tokensOut,
            minimumAmountOut: buyMinimumFromQuote(
              quote,
              buy.quoteIn,
              buy.slippageBps,
            ),
            calls: await pons.buildOpenCalls(buy, {
              account: session.account,
              publicClient: client.config.publicClient,
            }),
          };
        }
        const sell = intent as PonsV2SellIntent;
        const amountOut = await quotePonsV2Sell(
          client.config.publicClient,
          sell.curve,
          sell.tokensIn,
        );
        return {
          amountIn: sell.tokensIn,
          amountOut,
          minimumAmountOut: applySlippage(amountOut, sell.slippageBps),
          calls: await pons.buildCloseCalls(sell, {
            account: session.account,
            publicClient: client.config.publicClient,
          }),
        };
      },
    },
  });
}

export async function ensureRobinhoodMainnet(
  provider: Eip1193Provider,
): Promise<void> {
  const current = await provider.request({ method: "eth_chainId" });
  if (
    typeof current === "string" &&
    current.toLowerCase() === ROBINHOOD_CHAIN_HEX
  )
    return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ROBINHOOD_CHAIN_HEX }],
    });
  } catch (error) {
    if (!isUnknownChainError(error)) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: ROBINHOOD_CHAIN_HEX,
          chainName: "Robinhood Chain",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
          blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
        },
      ],
    });
  }
}

function creatorTaxFromLegacySlider(creatorSharePercent: number): number {
  if (!Number.isFinite(creatorSharePercent)) return 0;
  return Math.max(0, Math.min(1_000, Math.round(creatorSharePercent * 10)));
}

function injectedProvider(): Eip1193Provider {
  const value = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!value) throw new Error("Install MetaMask to use PrivatePons live mode.");
  return value;
}

function randomAccountIndex(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return 1 + (value[0]! % 2_147_483_646);
}

function isUnknownChainError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const walletError = error as {
    code?: unknown;
    data?: { originalError?: { code?: unknown } };
  };
  return (
    walletError.code === 4902 || walletError.data?.originalError?.code === 4902
  );
}
