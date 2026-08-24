import {
  createHttpRelay,
  PrivateLaunchpadClient,
  type PrivacyBridgeEngine,
} from "@private-launchpad/sdk";
import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type PublicClient,
} from "viem";
import {
  loadOfficialBridgeEngine,
  type OfficialBridgeLoadOptions,
} from "./official-bridge.js";

const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_USDC =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;

export interface BaseSepoliaLiveClientDependencies {
  publicClient?: PublicClient;
  fetch?: typeof fetch;
  loadBridge?: (
    options: OfficialBridgeLoadOptions,
  ) => Promise<PrivacyBridgeEngine>;
}

/**
 * Wires the official bridge, Base reader, and policy relayer into the plugin
 * client. It deliberately stops before wallet and host-adapter concerns: those
 * remain injected into createLiveRuntime by the launchpad that owns the UI.
 */
export async function createBaseSepoliaLiveClient(
  environment: Readonly<Record<string, unknown>>,
  dependencies: BaseSepoliaLiveClientDependencies = {},
): Promise<PrivateLaunchpadClient> {
  const factory = environmentAddress(
    environment,
    "VITE_PRIVATE_LAUNCHPAD_FACTORY",
  );
  const rpcUrl = environmentString(environment, "VITE_BASE_RPC_URL");
  const relayerUrl = environmentString(
    environment,
    "VITE_PRIVATE_LAUNCHPAD_RELAYER_URL",
  );
  const publicClient: PublicClient =
    dependencies.publicClient ??
    (createPublicClient({ transport: http(rpcUrl) }) as PublicClient);

  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Base RPC returned chain ${actualChainId}, expected ${BASE_SEPOLIA_CHAIN_ID}`,
    );
  }
  const factoryCode = await publicClient.getBytecode({ address: factory });
  if (!factoryCode || factoryCode === "0x") {
    throw new Error(
      `private launchpad factory has no Base Sepolia code at ${factory}`,
    );
  }

  const loadBridge = dependencies.loadBridge ?? loadOfficialBridgeEngine;
  const bridge = await loadBridge({ environment });
  const relay = createHttpRelay({
    endpoint: relayerUrl,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  });
  return new PrivateLaunchpadClient({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    factory,
    usdc: BASE_SEPOLIA_USDC,
    publicClient,
    relay,
    bridge,
  });
}

function environmentString(
  environment: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = environment[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required for the live Base Sepolia client`);
  }
  return value;
}

function environmentAddress(
  environment: Readonly<Record<string, unknown>>,
  name: string,
): Address {
  const value = environmentString(environment, name);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${name} must be a 20-byte EVM address`);
  }
}
