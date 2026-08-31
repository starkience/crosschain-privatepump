import {
  createStarkwarePrivacyBridgeEngine,
  type PrivacyBridgeEngine,
  type StarkwarePrivacyBridgeExports,
} from "@private-launchpad/sdk";
import pins from "../../../config/official-bridge.json";

export const OFFICIAL_BRIDGE_MODULE_URL = "/vendor/privacy-bridge-v0.1.22.mjs";
export const OFFICIAL_BRIDGE_MANIFEST_URL = "/vendor/manifest.json";

const expectedPins = {
  sdk: pins.sdk.commit,
  bridge: pins.bridge.commit,
};

const STARKNET_SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
const STRK20_SEPOLIA_POOL =
  "0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
const OUTBOUND_ANONYMIZER =
  "0x05b85f2ae4d47c1e661533d5832fe3e4afd4c6a9b52e54b7f873a00c9b285f4e";
const INBOUND_ANONYMIZER =
  "0x00d2a07c657d8c70f6eeddb7c8125e39b0955a40a608f63ca8a88d3ebbf72117";
const STARKNET_SEPOLIA_USDC =
  "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343";
const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_CCTP_DOMAIN = 6;
const OZ_ACCOUNT_CLASS =
  "0x5b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564";
const PAYMASTER_PROXY_SENTINEL = "same-origin-proxy";
const STARKNET_MAINNET_CHAIN_ID = "0x534e5f4d41494e";
const STRK20_MAINNET_POOL =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const MAINNET_OUTBOUND_ANONYMIZER =
  "0x009067f35d2cab3cb933f3d78793660402026f8fa31e041ca2cab4a8e9a49092";
const MAINNET_INBOUND_ANONYMIZER =
  "0x03a7e7f34e530f8ec00b1ff7eaca90a136311d9da7cb17a73203f813b56c86cb";
const STARKNET_MAINNET_USDC =
  "0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb";
const ARBITRUM_CHAIN_ID = 42161;
const ARBITRUM_CCTP_DOMAIN = 3;
const ARBITRUM_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

interface OfficialBridgeManifest {
  schemaVersion: 1;
  module: string;
  sha256: string;
  requiredExports: readonly string[];
  sdk: { commit: string };
  bridge: { commit: string };
}

interface OfficialBridgeEnvironment {
  readonly dev?: boolean;
  readonly prod?: boolean;
  readonly vars: Readonly<Record<string, string | undefined>>;
}

interface OfficialBridgeChainConfig {
  chainId: number;
  domain: number;
  usdc?: string;
  usdcAddress?: string;
}

interface OfficialBridgeResolvedConfig {
  network: string;
  chainId: string;
  poolAddress: string;
  ozClassHash: string;
  anonymizerAddress: string;
  inboundAnonymizerAddress: string;
  depositToken: { address: string };
  paymaster?: { endpoint: string; apiKey: string };
  cctp: {
    starknetDomain: number;
    defaultDestChainId: number;
  };
  evmCctpSources: Record<number, OfficialBridgeChainConfig>;
  evmCctpDestinations: Record<number, OfficialBridgeChainConfig>;
  rpcUrl: string;
  proverUrl: string;
  indexerUrl: string;
}

interface OfficialBridgeConfigurationExports {
  bridgeEnvFromRecord(
    source: Readonly<Record<string, unknown>>,
    prefix: string,
  ): OfficialBridgeEnvironment;
  initBridgeConfig(environment: OfficialBridgeEnvironment): void;
  getActiveConfig(): OfficialBridgeResolvedConfig;
}

export interface OfficialBridgeLoadOptions {
  environment: Readonly<Record<string, unknown>>;
  route?: "base-sepolia" | "pons-mainnet";
  environmentPrefix?: string;
  manifestUrl?: string;
}

export function validateOfficialBridgeManifest(
  value: unknown,
): OfficialBridgeManifest {
  if (!value || typeof value !== "object") {
    throw new Error("official privacy bridge manifest did not load");
  }
  const manifest = value as Partial<OfficialBridgeManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.module !== OFFICIAL_BRIDGE_MODULE_URL.split("/").at(-1) ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256 ?? "") ||
    JSON.stringify(manifest.requiredExports) !==
      JSON.stringify(pins.requiredExports) ||
    manifest.sdk?.commit !== expectedPins.sdk ||
    manifest.bridge?.commit !== expectedPins.bridge
  ) {
    throw new Error(
      "official privacy bridge manifest does not match pinned source",
    );
  }
  return manifest as OfficialBridgeManifest;
}

export function validateOfficialBridgeModule(
  value: unknown,
): StarkwarePrivacyBridgeExports {
  if (!value || typeof value !== "object") {
    throw new Error("official privacy bridge module did not load");
  }
  const module = value as Record<string, unknown>;
  for (const name of [
    "deriveStarknetPrivateKey",
    "deriveStarknetAccount",
    "deriveViewingKey",
    "deriveAccountNonce",
    "discoverPrivateBalanceForAddress",
    "readUndepositedResidual",
    "getActiveConfig",
    "derivePolygonEoa",
    "fetchForwardMaxFee",
    "bridgeOut",
    "sendPrivateToStarknet",
    "moveIntoPool",
    "cashOut",
    "fundAccountFromPool",
    "returnToPool",
  ] as const) {
    if (typeof module[name] !== "function") {
      throw new Error(`official privacy bridge is missing ${name}`);
    }
  }
  return module as unknown as StarkwarePrivacyBridgeExports;
}

export function configureOfficialBridgeForPonsMainnet(
  value: unknown,
  environment: Readonly<Record<string, unknown>>,
  environmentPrefix = "VITE_",
): StarkwarePrivacyBridgeExports {
  const bridge = validateOfficialBridgeModule(value);
  const configuration = validateOfficialBridgeConfigurationModule(value);
  const forced = {
    ...environment,
    [`${environmentPrefix}NETWORK`]: "mainnet",
    [`${environmentPrefix}CCTP_FAST`]: "true",
    [`${environmentPrefix}CCTP_DEFAULT_DEST_CHAIN_ID`]:
      String(ARBITRUM_CHAIN_ID),
  };
  configuration.initBridgeConfig(
    configuration.bridgeEnvFromRecord(forced, environmentPrefix),
  );
  validatePonsMainnetBridgeConfig(configuration.getActiveConfig());
  return bridge;
}

export function validatePonsMainnetBridgeConfig(
  value: unknown,
): OfficialBridgeResolvedConfig {
  if (!value || typeof value !== "object") {
    throw new Error(
      "official privacy bridge did not resolve its configuration",
    );
  }
  const config = value as Partial<OfficialBridgeResolvedConfig>;
  const source = config.evmCctpSources?.[ARBITRUM_CHAIN_ID];
  const destination = config.evmCctpDestinations?.[ARBITRUM_CHAIN_ID];
  const same = (actual: string | undefined, expected: string) =>
    actual?.toLowerCase() === expected.toLowerCase();
  if (
    config.network !== "mainnet" ||
    config.chainId?.toLowerCase() !== STARKNET_MAINNET_CHAIN_ID ||
    !same(config.poolAddress, STRK20_MAINNET_POOL) ||
    !same(config.anonymizerAddress, MAINNET_OUTBOUND_ANONYMIZER) ||
    !same(config.inboundAnonymizerAddress, MAINNET_INBOUND_ANONYMIZER) ||
    !same(config.depositToken?.address, STARKNET_MAINNET_USDC) ||
    !same(config.ozClassHash, OZ_ACCOUNT_CLASS) ||
    config.cctp?.starknetDomain !== 25 ||
    config.cctp?.defaultDestChainId !== ARBITRUM_CHAIN_ID ||
    source?.chainId !== ARBITRUM_CHAIN_ID ||
    source?.domain !== ARBITRUM_CCTP_DOMAIN ||
    !same(source?.usdc, ARBITRUM_USDC) ||
    destination?.chainId !== ARBITRUM_CHAIN_ID ||
    destination?.domain !== ARBITRUM_CCTP_DOMAIN ||
    !same(destination?.usdcAddress, ARBITRUM_USDC)
  ) {
    throw new Error(
      "official privacy bridge configuration is not the canonical STRK20 mainnet -> Arbitrum route",
    );
  }
  validatePrivateProxies(config);
  return config as OfficialBridgeResolvedConfig;
}

export function validateOfficialBridgeConfigurationModule(
  value: unknown,
): OfficialBridgeConfigurationExports {
  if (!value || typeof value !== "object") {
    throw new Error("official privacy bridge configuration did not load");
  }
  const module = value as Record<string, unknown>;
  for (const name of [
    "bridgeEnvFromRecord",
    "initBridgeConfig",
    "getActiveConfig",
  ] as const) {
    if (typeof module[name] !== "function") {
      throw new Error(
        `official privacy bridge configuration is missing ${name}`,
      );
    }
  }
  return module as unknown as OfficialBridgeConfigurationExports;
}

export function configureOfficialBridgeForBaseSepolia(
  value: unknown,
  environment: Readonly<Record<string, unknown>>,
  environmentPrefix = "VITE_",
): StarkwarePrivacyBridgeExports {
  const bridge = validateOfficialBridgeModule(value);
  const configuration = validateOfficialBridgeConfigurationModule(value);
  const networkKey = `${environmentPrefix}NETWORK`;
  const destinationKey = `${environmentPrefix}CCTP_DEFAULT_DEST_CHAIN_ID`;
  const network = environment[networkKey];
  if (network !== undefined && network !== "testnet") {
    throw new Error(`${networkKey} must be testnet`);
  }
  const destination = environment[destinationKey];
  if (
    destination !== undefined &&
    destination !== String(BASE_SEPOLIA_CHAIN_ID)
  ) {
    throw new Error(`${destinationKey} must be ${BASE_SEPOLIA_CHAIN_ID}`);
  }

  const baseSepoliaEnvironment = {
    ...environment,
    [networkKey]: "testnet",
    [destinationKey]: String(BASE_SEPOLIA_CHAIN_ID),
  };
  configuration.initBridgeConfig(
    configuration.bridgeEnvFromRecord(
      baseSepoliaEnvironment,
      environmentPrefix,
    ),
  );
  validateBaseSepoliaBridgeConfig(configuration.getActiveConfig());
  return bridge;
}

export function validateBaseSepoliaBridgeConfig(
  value: unknown,
): OfficialBridgeResolvedConfig {
  if (!value || typeof value !== "object") {
    throw new Error(
      "official privacy bridge did not resolve its configuration",
    );
  }
  const config = value as Partial<OfficialBridgeResolvedConfig>;
  const source = config.evmCctpSources?.[BASE_SEPOLIA_CHAIN_ID];
  const destination = config.evmCctpDestinations?.[BASE_SEPOLIA_CHAIN_ID];
  const same = (actual: string | undefined, expected: string) =>
    actual?.toLowerCase() === expected;
  if (
    config.network !== "testnet" ||
    config.chainId?.toLowerCase() !== STARKNET_SEPOLIA_CHAIN_ID ||
    !same(config.poolAddress, STRK20_SEPOLIA_POOL) ||
    !same(config.anonymizerAddress, OUTBOUND_ANONYMIZER) ||
    !same(config.inboundAnonymizerAddress, INBOUND_ANONYMIZER) ||
    !same(config.depositToken?.address, STARKNET_SEPOLIA_USDC) ||
    !same(config.ozClassHash, OZ_ACCOUNT_CLASS) ||
    config.cctp?.starknetDomain !== 25 ||
    config.cctp?.defaultDestChainId !== BASE_SEPOLIA_CHAIN_ID ||
    source?.chainId !== BASE_SEPOLIA_CHAIN_ID ||
    source?.domain !== BASE_CCTP_DOMAIN ||
    !same(source?.usdc, BASE_SEPOLIA_USDC) ||
    destination?.chainId !== BASE_SEPOLIA_CHAIN_ID ||
    destination?.domain !== BASE_CCTP_DOMAIN ||
    !same(destination?.usdcAddress, BASE_SEPOLIA_USDC)
  ) {
    throw new Error(
      "official privacy bridge configuration is not the canonical Base Sepolia route",
    );
  }
  validatePrivateProxies(config);
  return config as OfficialBridgeResolvedConfig;
}

function validatePrivateProxies(
  config: Partial<OfficialBridgeResolvedConfig>,
): void {
  if (!config.paymaster?.endpoint || !config.paymaster.apiKey) {
    throw new Error(
      "official privacy bridge requires an AVNU paymaster for the live browser route",
    );
  }
  if (
    !config.paymaster.endpoint.startsWith("/") ||
    config.paymaster.apiKey !== PAYMASTER_PROXY_SENTINEL
  ) {
    throw new Error(
      "official privacy bridge AVNU requests must use the same-origin paymaster proxy",
    );
  }
  for (const [name, url] of [
    ["RPC", config.rpcUrl],
    ["prover", config.proverUrl],
    ["indexer", config.indexerUrl],
  ] as const) {
    if (!url || !url.startsWith("/")) {
      throw new Error(
        `official privacy bridge ${name} must use a same-origin privacy proxy`,
      );
    }
  }
}

export async function loadOfficialBridgeEngine(
  options: OfficialBridgeLoadOptions,
): Promise<PrivacyBridgeEngine> {
  const manifestUrl = options.manifestUrl ?? OFFICIAL_BRIDGE_MANIFEST_URL;
  const manifestResponse = await fetch(manifestUrl, { cache: "no-store" });
  if (!manifestResponse.ok) {
    throw new Error(
      `official privacy bridge manifest returned ${manifestResponse.status}`,
    );
  }
  const manifest = validateOfficialBridgeManifest(
    await manifestResponse.json(),
  );
  const moduleUrl = new URL(manifest.module, manifestResponse.url).href;
  const moduleResponse = await fetch(moduleUrl, { cache: "no-store" });
  if (!moduleResponse.ok) {
    throw new Error(
      `official privacy bridge module returned ${moduleResponse.status}`,
    );
  }
  const source = await moduleResponse.arrayBuffer();
  if ((await sha256(source)) !== manifest.sha256) {
    throw new Error("official privacy bridge module failed its SHA-256 check");
  }

  const objectUrl = URL.createObjectURL(
    new Blob([source], { type: "text/javascript" }),
  );
  try {
    const module: unknown = await import(/* @vite-ignore */ objectUrl);
    const configured =
      options.route === "pons-mainnet"
        ? configureOfficialBridgeForPonsMainnet(
            module,
            options.environment,
            options.environmentPrefix,
          )
        : configureOfficialBridgeForBaseSepolia(
            module,
            options.environment,
            options.environmentPrefix,
          );
    return createStarkwarePrivacyBridgeEngine(configured);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function sha256(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
