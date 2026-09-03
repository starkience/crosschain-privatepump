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

const ROBINHOOD_CHAIN_HEX =
  `0x${ROBINHOOD_MAINNET_CHAIN_ID.toString(16)}` as `0x${string}`;
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

type MetaMaskConnectModule = typeof import("@metamask/connect-evm");
type MetaMaskConnectClient = Awaited<
  ReturnType<MetaMaskConnectModule["createEVMClient"]>
>;

const announcedWalletProviders = new Map<string, BrowserInjectedProvider>();
let walletProviderDiscoveryRequested = false;

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = (event as CustomEvent<AnnouncedWalletProvider>).detail;
    if (detail?.info?.rdns === "io.metamask" && detail.provider) {
      announcedWalletProviders.set(detail.info.rdns, detail.provider);
    }
  });
}

export async function createPrivatePonsLiveRuntime(
  environment: Readonly<Record<string, unknown>>,
): Promise<LaunchpadRuntime> {
  const client = await createPonsMainnetLiveClient(environment);
  const pons = ponsV2Adapter();
  let activeWalletProvider: Eip1193Provider | undefined;
  let walletProviderSelection = 0;
  let mobileMetaMaskClient: Promise<MetaMaskConnectClient> | undefined;

  const selectInjectedMetaMask = async () => {
    const selection = ++walletProviderSelection;
    const provider = injectedProvider();
    const address = await connectMetaMask(provider);
    if (selection === walletProviderSelection) activeWalletProvider = provider;
    return address;
  };

  const selectMobileMetaMask = async () => {
    const selection = ++walletProviderSelection;
    mobileMetaMaskClient ??= createMobileMetaMaskClient();
    const mobileClient = await mobileMetaMaskClient;
    const result = await mobileClient.connect({
      chainIds: [ROBINHOOD_CHAIN_HEX],
      forceRequest: true,
    });
    const provider = mobileClient.getProvider() as Eip1193Provider;
    const account = result.accounts[0];
    if (!account || !isAddress(account)) {
      throw new Error("MetaMask mobile did not return an EVM account");
    }
    await ensureRobinhoodMainnet(provider);
    if (selection === walletProviderSelection) activeWalletProvider = provider;
    return getAddress(account);
  };

  const selectedWalletProvider = () =>
    activeWalletProvider ?? injectedProvider();
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
    connectWallet: selectInjectedMetaMask,
    connectWalletFallback: selectMobileMetaMask,
    signIdentity: async ({ address, message }) => {
      const wallet = createWalletClient({
        transport: custom(selectedWalletProvider()),
      });
      return wallet.signMessage({ account: address, message });
    },
    depositProvider: selectedWalletProvider,
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

async function createMobileMetaMaskClient(): Promise<MetaMaskConnectClient> {
  const { createEVMClient } = await import("@metamask/connect-evm");
  return createEVMClient({
    dapp: {
      name: "PonsButPrivate",
      url: window.location.origin,
      iconUrl: new URL("/favicon.svg", window.location.origin).href,
    },
    api: {
      supportedNetworks: {
        [ROBINHOOD_CHAIN_HEX]: new URL("/robinhood-rpc", window.location.origin)
          .href,
      },
    },
    analytics: { enabled: false },
    ui: {
      // This connector is intentionally the escape hatch for a broken browser
      // extension stream, so it must display the mobile QR even when MetaMask
      // is installed in this browser.
      preferExtension: false,
    },
    skipAutoAnnounce: true,
  });
}

export async function connectMetaMask(
  provider: Eip1193Provider,
): Promise<Address> {
  // Request account permission before all passive reads. Unlike
  // eth_requestAccounts on an already-authorized origin, this opens MetaMask's
  // account approval/unlock UI instead of returning silently. Older providers
  // that do not implement wallet_requestPermissions retain the standard path.
  let accounts: unknown;
  try {
    await provider.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
    accounts = await provider.request({ method: "eth_accounts" });
  } catch (error) {
    if (!isUnsupportedProviderMethod(error)) throw error;
    accounts = await provider.request({ method: "eth_requestAccounts" });
  }
  if (!Array.isArray(accounts) || !isAddress(accounts[0])) {
    throw new Error("wallet did not return an EVM account");
  }
  await ensureRobinhoodMainnet(provider);
  return getAddress(accounts[0]);
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

  const announced = announcedProviders.get("io.metamask");
  if (announced) return announced;

  throw new Error(
    "MetaMask was not found. Enable MetaMask for this site, then retry.",
  );
}

function injectedProvider(): Eip1193Provider {
  // Prefer the isolated MetaMask entry from the legacy multi-provider list.
  // Broadcasting an EIP-6963 request wakes every installed wallet extension;
  // only do that once, and only when the clean legacy MetaMask provider is not
  // already available. This avoids repeatedly exercising broken Phantom or
  // stale extension message streams during one private workflow.
  const value = (window as unknown as { ethereum?: BrowserInjectedProvider })
    .ethereum;
  try {
    return selectMetaMaskProvider(value, new Map());
  } catch (legacyError) {
    if (!walletProviderDiscoveryRequested) {
      walletProviderDiscoveryRequested = true;
      window.dispatchEvent(new Event("eip6963:requestProvider"));
    }
    try {
      return selectMetaMaskProvider(value);
    } catch {
      throw legacyError;
    }
  }
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

function isUnsupportedProviderMethod(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const walletError = error as {
    code?: unknown;
    data?: { originalError?: { code?: unknown } };
  };
  return (
    walletError.code === 4200 ||
    walletError.code === -32601 ||
    walletError.data?.originalError?.code === 4200 ||
    walletError.data?.originalError?.code === -32601
  );
}
