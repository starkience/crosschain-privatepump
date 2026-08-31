import {
  clankerTradeAdapter,
  clankerV4LaunchAdapter,
  createClankerV4UsdcPool,
  createHttpClankerTradeQuoteProvider,
  prepareClankerV4Launch,
  type ClankerTradeIntent,
  type ClankerV4LaunchIntent,
  type Eip1193Provider,
} from "@private-launchpad/sdk";
import {
  createWalletClient,
  custom,
  getAddress,
  isAddress,
  isHex,
  type Address,
} from "viem";
import { createBaseSepoliaLiveClient } from "./live-client.js";
import { createLiveRuntime, type LaunchpadRuntime } from "./runtime.js";

const BASE_SEPOLIA_USDC =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const BASE_SEPOLIA_CHAIN_HEX = "0x14a34";

/** Complete browser binding for the Base Sepolia Plank runtime. */
export async function createPrivateClankerLiveRuntime(
  environment: Readonly<Record<string, unknown>>,
): Promise<LaunchpadRuntime> {
  const client = await createBaseSepoliaLiveClient(environment);
  const builder = environmentAddress(
    environment,
    "VITE_CLANKER_BUILDER_ADDRESS",
  );
  const quoteEndpoint = environmentString(
    environment,
    "VITE_CLANKER_QUOTE_URL",
  );
  const launchAdapter = clankerV4LaunchAdapter(84532, {
    builder: { admin: builder, recipient: builder },
    interfaceName: "Plank",
    ...optionalBuilderCode(environment),
  });
  const tradeAdapter = clankerTradeAdapter(
    84532,
    BASE_SEPOLIA_USDC,
    createHttpClankerTradeQuoteProvider({ endpoint: quoteEndpoint }),
  );

  return createLiveRuntime<ClankerV4LaunchIntent, never, ClankerTradeIntent>({
    appId: "private-clanker",
    accountIndex: randomAccountIndex,
    fastFunding: true,
    client,
    adapter: launchAdapter,
    connectWallet: async () => {
      const provider = injectedProvider();
      await ensureBaseSepolia(provider);
      const accounts = await provider.request({
        method: "eth_requestAccounts",
      });
      if (!Array.isArray(accounts) || !isAddress(accounts[0])) {
        throw new Error("wallet did not return an EVM account");
      }
      return getAddress(accounts[0]);
    },
    signIdentity: async ({ address, message }) => {
      const provider = injectedProvider();
      const wallet = createWalletClient({ transport: custom(provider) });
      return wallet.signMessage({ account: address, message });
    },
    depositProvider: () => injectedProvider(),
    buildOpenIntent: (draft) => ({
      name: draft.name,
      symbol: draft.symbol,
      ...(draft.description ? { description: draft.description } : {}),
      creatorRewardBps: draft.creatorReward * 100,
      salt: draft.salt,
      pool: createClankerV4UsdcPool(BASE_SEPOLIA_USDC),
    }),
    resolveOpenToken: async (intent, session) =>
      (
        await prepareClankerV4Launch(
          84532,
          intent,
          { account: session.account },
          {
            builder: { admin: builder, recipient: builder },
            interfaceName: "Plank",
            ...optionalBuilderCode(environment),
          },
        )
      ).expectedToken,
    trade: {
      buildIntent: (draft) => draft,
      quote: (side, intent, session) =>
        tradeAdapter.quote(side, intent, {
          account: session.account,
          publicClient: client.config.publicClient,
        }),
    },
  });
}

export async function ensureBaseSepolia(
  provider: Eip1193Provider,
): Promise<void> {
  const currentChain = await provider.request({ method: "eth_chainId" });
  if (
    typeof currentChain === "string" &&
    currentChain.toLowerCase() === BASE_SEPOLIA_CHAIN_HEX
  ) {
    return;
  }

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_SEPOLIA_CHAIN_HEX }],
    });
  } catch (error) {
    if (!isUnknownChainError(error)) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: BASE_SEPOLIA_CHAIN_HEX,
          chainName: "Base Sepolia",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://sepolia.base.org"],
          blockExplorerUrls: ["https://sepolia.basescan.org"],
        },
      ],
    });
  }
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

function optionalBuilderCode(
  environment: Readonly<Record<string, unknown>>,
): { dataSuffix: `0x${string}` } | Record<string, never> {
  const value = environment.VITE_BASE_BUILDER_CODE_SUFFIX;
  if (value === undefined || value === "") return {};
  if (typeof value !== "string" || !isHex(value)) {
    throw new Error("VITE_BASE_BUILDER_CODE_SUFFIX must be hex");
  }
  return { dataSuffix: value };
}

function injectedProvider(): Eip1193Provider {
  const value = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!value) {
    throw new Error("Install MetaMask to use Base Sepolia live mode.");
  }
  return value;
}

function randomAccountIndex(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return 1 + (value[0]! % 2_147_483_646);
}

function environmentString(
  environment: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = environment[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required for Plank live mode`);
  }
  return value;
}

function environmentAddress(
  environment: Readonly<Record<string, unknown>>,
  name: string,
): Address {
  try {
    return getAddress(environmentString(environment, name));
  } catch {
    throw new Error(`${name} must be a 20-byte EVM address`);
  }
}
