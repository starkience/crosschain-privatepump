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
const ROBINHOOD_READ_ATTEMPTS = 4;
const ROBINHOOD_READ_RETRY_BASE_MS = 500;

interface BrowserInjectedProvider extends Eip1193Provider {
  readonly isMetaMask?: boolean;
  readonly isPhantom?: boolean;
  readonly isCoinbaseWallet?: boolean;
  readonly providers?: readonly BrowserInjectedProvider[];
}

interface AnnouncedWalletProvider {
  readonly info: { readonly rdns: string };
  readonly provider: BrowserInjectedProvider;
}

const announcedWalletProviders = new Map<string, BrowserInjectedProvider>();

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = (event as CustomEvent<AnnouncedWalletProvider>).detail;
    if (detail?.info?.rdns && detail.provider) {
      announcedWalletProviders.set(detail.info.rdns, detail.provider);
    }
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

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
    recoverPositions: ({ signature, signal }) =>
      recoverPonsPositions({
        client,
        signature,
        ...(signal ? { signal } : {}),
      }),
    buildOpenIntent: (draft) => ({
      name: draft.name,
      symbol: draft.symbol,
      ...(draft.description ? { description: draft.description } : {}),
      creatorTaxBps: creatorTaxFromLegacySlider(draft.creatorReward),
      buybackEnabled: false,
      salt: draft.salt,
    }),
    openOptions: async () => ({
      prefund: await retryRobinhoodRead(() =>
        client.config.publicClient.readContract({
          address: PONS_V2_ROBINHOOD.factory,
          abi: ponsV2FactoryAbi,
          functionName: "launchFee",
        }),
      ),
    }),
    resolveOpenTokenAfterExecution: async (
      transactionHash,
      _intent,
      session,
    ) => {
      const receipt = await retryRobinhoodRead(() =>
        client.config.publicClient.waitForTransactionReceipt({
          hash: transactionHash,
          confirmations: 1,
          timeout: 120_000,
        }),
      );
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
        const launch = await retryRobinhoodRead(() =>
          client.config.publicClient.readContract({
            address: PONS_V2_ROBINHOOD.factory,
            abi: ponsV2FactoryAbi,
            functionName: "getLaunchedToken",
            args: [getAddress(draft.token)],
          }),
        );
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
        return retryRobinhoodRead(async () => {
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
        });
      },
    },
  });
}

async function retryRobinhoodRead<T>(read: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ROBINHOOD_READ_ATTEMPTS; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        !/too many requests|\b429\b|rate[ -]?limit/i.test(message) ||
        attempt + 1 >= ROBINHOOD_READ_ATTEMPTS
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, ROBINHOOD_READ_RETRY_BASE_MS * 2 ** attempt),
      );
    }
  }
  throw lastError;
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

export function selectMetaMaskProvider(
  legacyProvider: BrowserInjectedProvider | undefined,
  announcedProviders: ReadonlyMap<
    string,
    BrowserInjectedProvider
  > = announcedWalletProviders,
): Eip1193Provider {
  const announced = announcedProviders.get("io.metamask");
  if (announced) return announced;

  const candidates = legacyProvider?.providers?.length
    ? legacyProvider.providers
    : legacyProvider
      ? [legacyProvider]
      : [];
  const metamask = candidates.find(
    (provider) =>
      provider.isMetaMask === true &&
      provider.isPhantom !== true &&
      provider.isCoinbaseWallet !== true,
  );
  if (metamask) return metamask;

  throw new Error(
    "MetaMask was not found. Enable MetaMask for this site, then retry.",
  );
}

function injectedProvider(): Eip1193Provider {
  // EIP-6963 avoids relying on whichever extension last overwrote
  // window.ethereum. Request another announcement in case MetaMask loaded
  // after this module initialized, then fall back to the legacy provider list.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const value = (window as unknown as { ethereum?: BrowserInjectedProvider })
    .ethereum;
  return selectMetaMaskProvider(value);
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
