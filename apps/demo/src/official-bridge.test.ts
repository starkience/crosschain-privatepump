import { describe, expect, it, vi } from "vitest";
import {
  configureOfficialBridgeForBaseSepolia,
  validateBaseSepoliaBridgeConfig,
  validateOfficialBridgeConfigurationModule,
  validateOfficialBridgeManifest,
  validateOfficialBridgeModule,
} from "./official-bridge.js";

const requiredExports = [
  "bridgeEnvFromRecord",
  "initBridgeConfig",
  "getActiveConfig",
  "derivePolygonEoa",
  "fundAccountFromPool",
  "returnToPool",
];

const manifest = {
  schemaVersion: 1,
  module: "privacy-bridge-v0.1.22.mjs",
  sha256: "a".repeat(64),
  requiredExports,
  sdk: { commit: "efc61cbbdab5b714b5cf915f9735d88948e2ea82" },
  bridge: { commit: "3e95694b997069c47eff52cd576af0bb3e03612d" },
};

const bridgeFunctions = {
  derivePolygonEoa: vi.fn(),
  fundAccountFromPool: vi.fn(),
  returnToPool: vi.fn(),
};

function canonicalConfig() {
  return {
    network: "testnet",
    chainId: "0x534e5f5345504f4c4941",
    poolAddress:
      "0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91",
    ozClassHash:
      "0x5b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564",
    anonymizerAddress:
      "0x05b85f2ae4d47c1e661533d5832fe3e4afd4c6a9b52e54b7f873a00c9b285f4e",
    inboundAnonymizerAddress:
      "0x00d2a07c657d8c70f6eeddb7c8125e39b0955a40a608f63ca8a88d3ebbf72117",
    depositToken: {
      address:
        "0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343",
    },
    paymaster: {
      endpoint: "/api/avnu",
      apiKey: "same-origin-proxy",
    },
    cctp: { starknetDomain: 25, defaultDestChainId: 84532 },
    evmCctpSources: {
      84532: {
        chainId: 84532,
        domain: 6,
        usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      },
    },
    evmCctpDestinations: {
      84532: {
        chainId: 84532,
        domain: 6,
        usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      },
    },
    rpcUrl: "/rpc/testnet",
    proverUrl: "/prover/testnet",
    indexerUrl: "/indexer/testnet",
  };
}

describe("official bridge runtime loader", () => {
  it("accepts only the bridge surface consumed by the plugin", () => {
    const bridge = {
      ...bridgeFunctions,
      unrelatedExport: true,
    };
    expect(validateOfficialBridgeModule(bridge)).toBe(bridge);
  });

  it.each([
    undefined,
    {},
    { derivePolygonEoa: vi.fn(), fundAccountFromPool: vi.fn() },
  ])("rejects an incomplete module", (module) => {
    expect(() => validateOfficialBridgeModule(module)).toThrow(
      /did not load|is missing/,
    );
  });

  it("accepts only the pinned source-build manifest", () => {
    expect(validateOfficialBridgeManifest(manifest)).toBe(manifest);
    expect(() =>
      validateOfficialBridgeManifest({
        ...manifest,
        bridge: { commit: "b".repeat(40) },
      }),
    ).toThrow(/does not match pinned source/);
    expect(() =>
      validateOfficialBridgeManifest({
        ...manifest,
        requiredExports: requiredExports.slice(3),
      }),
    ).toThrow(/does not match pinned source/);
  });

  it("requires and initializes the official configuration surface", () => {
    const bridgeEnvFromRecord = vi.fn(() => ({
      dev: true,
      vars: { NETWORK: "testnet" },
    }));
    const initBridgeConfig = vi.fn();
    const module = {
      ...bridgeFunctions,
      bridgeEnvFromRecord,
      initBridgeConfig,
      getActiveConfig: vi.fn(canonicalConfig),
    };

    expect(validateOfficialBridgeConfigurationModule(module)).toBe(module);
    expect(
      configureOfficialBridgeForBaseSepolia(module, {
        DEV: true,
        VITE_OZ_ACCOUNT_CLASS_HASH_TESTNET: "0x1234",
        VITE_AVNU_PAYMASTER_API_KEY: "test",
      }),
    ).toBe(module);
    expect(bridgeEnvFromRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        VITE_NETWORK: "testnet",
        VITE_CCTP_DEFAULT_DEST_CHAIN_ID: "84532",
      }),
      "VITE_",
    );
    expect(initBridgeConfig).toHaveBeenCalledOnce();
  });

  it("fails closed on a non-Base or non-paymaster bridge configuration", () => {
    const wrongDestination = canonicalConfig();
    wrongDestination.cctp.defaultDestChainId = 80002;
    expect(() => validateBaseSepoliaBridgeConfig(wrongDestination)).toThrow(
      /canonical Base Sepolia route/,
    );

    const noPaymaster = canonicalConfig();
    noPaymaster.paymaster = undefined as never;
    expect(() => validateBaseSepoliaBridgeConfig(noPaymaster)).toThrow(
      /AVNU paymaster/,
    );

    const directPaymaster = canonicalConfig();
    directPaymaster.paymaster.endpoint = "https://sepolia.paymaster.avnu.fi";
    expect(() => validateBaseSepoliaBridgeConfig(directPaymaster)).toThrow(
      /same-origin paymaster proxy/,
    );
  });

  it("rejects operator overrides that could select the wrong network", () => {
    const module = {
      ...bridgeFunctions,
      bridgeEnvFromRecord: vi.fn(),
      initBridgeConfig: vi.fn(),
      getActiveConfig: vi.fn(canonicalConfig),
    };
    expect(() =>
      configureOfficialBridgeForBaseSepolia(module, {
        VITE_NETWORK: "mainnet",
      }),
    ).toThrow(/VITE_NETWORK must be testnet/);
    expect(() =>
      configureOfficialBridgeForBaseSepolia(module, {
        VITE_CCTP_DEFAULT_DEST_CHAIN_ID: "80002",
      }),
    ).toThrow(/must be 84532/);
  });
});
