import { describe, expect, it, vi } from "vitest";
import type { Eip1193Provider } from "@private-launchpad/sdk";
import { ensureBaseSepolia } from "./clanker-live.js";

describe("MetaMask Base Sepolia connection", () => {
  it("keeps MetaMask on Base Sepolia when it is already selected", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x14a34";
      throw new Error(`unexpected method: ${method}`);
    });

    await ensureBaseSepolia({ request } as Eip1193Provider);

    expect(request).toHaveBeenCalledOnce();
  });

  it("requests a switch to Base Sepolia from another network", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "wallet_switchEthereumChain") return null;
      throw new Error(`unexpected method: ${method}`);
    });

    await ensureBaseSepolia({ request } as Eip1193Provider);

    expect(request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x14a34" }],
    });
  });

  it("offers to add Base Sepolia when MetaMask does not know the chain", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "wallet_switchEthereumChain") {
        throw Object.assign(new Error("Unknown chain"), { code: 4902 });
      }
      if (method === "wallet_addEthereumChain") return null;
      throw new Error(`unexpected method: ${method}`);
    });

    await ensureBaseSepolia({ request } as Eip1193Provider);

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "wallet_addEthereumChain",
        params: [
          expect.objectContaining({
            chainId: "0x14a34",
            chainName: "Base Sepolia",
          }),
        ],
      }),
    );
  });
});
