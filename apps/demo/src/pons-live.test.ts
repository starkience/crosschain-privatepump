import { describe, expect, it, vi } from "vitest";
import type { Eip1193Provider } from "@private-launchpad/sdk";
import { ensureRobinhoodMainnet, selectMetaMaskProvider } from "./pons-live.js";

describe("MetaMask Robinhood connection", () => {
  it("selects MetaMask instead of another legacy injected wallet", () => {
    const phantom = {
      isMetaMask: true,
      isPhantom: true,
      request: vi.fn(),
    };
    const metamask = { isMetaMask: true, request: vi.fn() };
    const injected = {
      request: vi.fn(),
      providers: [phantom, metamask],
    };

    expect(selectMetaMaskProvider(injected)).toBe(metamask);
  });

  it("uses a clean legacy MetaMask without waking other announced wallets", () => {
    const legacy = { isMetaMask: true, request: vi.fn() };
    const announced = { isMetaMask: true, request: vi.fn() };

    expect(
      selectMetaMaskProvider(legacy, new Map([["io.metamask", announced]])),
    ).toBe(legacy);
  });

  it("falls back to MetaMask's EIP-6963 announcement", () => {
    const phantom = {
      isMetaMask: true,
      isPhantom: true,
      request: vi.fn(),
    };
    const announced = { isMetaMask: true, request: vi.fn() };

    expect(
      selectMetaMaskProvider(phantom, new Map([["io.metamask", announced]])),
    ).toBe(announced);
  });

  it("keeps MetaMask on Robinhood when it is already selected", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x1237";
      throw new Error(`unexpected method: ${method}`);
    });

    await ensureRobinhoodMainnet({ request } as Eip1193Provider);

    expect(request).toHaveBeenCalledOnce();
  });
});
