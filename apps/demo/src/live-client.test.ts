import { describe, expect, it, vi } from "vitest";
import type { PrivacyBridgeEngine } from "@private-launchpad/sdk";
import type { PublicClient } from "viem";
import {
  createBaseSepoliaLiveClient,
  createPonsMainnetLiveClient,
} from "./live-client.js";

const factory = "0x1111111111111111111111111111111111111111";
const environment = {
  VITE_PRIVATE_LAUNCHPAD_FACTORY: factory,
  VITE_BASE_RPC_URL: "/base-rpc",
  VITE_PRIVATE_LAUNCHPAD_RELAYER_URL: "/api/private-launchpad/v1/relay",
};
const bridge = {
  deriveEvmOwner: vi.fn(),
  moveIntoPool: vi.fn(),
  cashOut: vi.fn(),
  fundAccountFromPool: vi.fn(),
  returnToPool: vi.fn(),
} as unknown as PrivacyBridgeEngine;

function publicClient(
  chainId = 84532,
  code: `0x${string}` | undefined = "0x6000",
) {
  return {
    getChainId: vi.fn(async () => chainId),
    getBytecode: vi.fn(async () => code),
  } as unknown as PublicClient;
}

describe("Base Sepolia live client", () => {
  it("preflights the chain and deployed factory before loading bridge secrets", async () => {
    const clientReader = publicClient();
    const loadBridge = vi.fn(async () => bridge);
    const client = await createBaseSepoliaLiveClient(environment, {
      publicClient: clientReader,
      loadBridge,
    });

    expect(client.config.chainId).toBe(84532);
    expect(client.config.factory).toBe(factory);
    expect(client.config.usdc).toBe(
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    );
    expect(clientReader.getBytecode).toHaveBeenCalledWith({ address: factory });
    expect(loadBridge).toHaveBeenCalledWith({ environment });
  });

  it("fails before bridge loading on a wrong RPC or undeployed factory", async () => {
    const loadBridge = vi.fn(async () => bridge);
    await expect(
      createBaseSepoliaLiveClient(environment, {
        publicClient: publicClient(8453),
        loadBridge,
      }),
    ).rejects.toThrow(/expected 84532/);
    await expect(
      createBaseSepoliaLiveClient(environment, {
        publicClient: publicClient(84532, "0x"),
        loadBridge,
      }),
    ).rejects.toThrow(/has no Base Sepolia code/);
    expect(loadBridge).not.toHaveBeenCalled();
  });

  it("requires all public host configuration", async () => {
    await expect(
      createBaseSepoliaLiveClient(
        { ...environment, VITE_PRIVATE_LAUNCHPAD_FACTORY: "" },
        { publicClient: publicClient() },
      ),
    ).rejects.toThrow(/VITE_PRIVATE_LAUNCHPAD_FACTORY is required/);
    await expect(
      createBaseSepoliaLiveClient(
        { ...environment, VITE_PRIVATE_LAUNCHPAD_FACTORY: "not-an-address" },
        { publicClient: publicClient() },
      ),
    ).rejects.toThrow(/must be a 20-byte EVM address/);
  });
});

describe("PrivatePons mainnet live client", () => {
  const ponsEnvironment = {
    VITE_PRIVATE_LAUNCHPAD_FACTORY: factory,
    VITE_ROBINHOOD_RPC_URL: "/robinhood-rpc",
    VITE_ARBITRUM_RPC_URL: "/arbitrum-rpc",
    VITE_RELAY_BRIDGE_URL: "/api/relay",
    VITE_PRIVATE_LAUNCHPAD_RELAYER_URL: "/api/private-launchpad/v1/relay",
  };

  it("preflights Robinhood and selects the Relay funding transport", async () => {
    const clientReader = publicClient(4663);
    const loadBridge = vi.fn(async () => bridge);
    const client = await createPonsMainnetLiveClient(ponsEnvironment, {
      publicClient: clientReader,
      loadBridge,
    });
    expect(client.config.chainId).toBe(4663);
    expect(client.config.usdc).toBe(
      "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    );
    expect(client.config.fundingTransport).toBeTypeOf("function");
    expect(client.config.depositTransport).toBeTypeOf("function");
    expect(client.channel).toBe("pons-private-v1");
    expect(loadBridge).toHaveBeenCalledWith({
      environment: ponsEnvironment,
      route: "pons-mainnet",
    });
  });
});
