import { describe, expect, it, vi } from "vitest";
import {
  createStarkwarePrivacyBridgeEngine,
  type StarkwarePrivacyBridgeExports,
} from "./bridge.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const ADDRESS = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";

function bridgeExports(
  derived: { privateKey: string; address: string } = {
    privateKey: PRIVATE_KEY,
    address: ADDRESS,
  },
): StarkwarePrivacyBridgeExports {
  return {
    derivePolygonEoa: vi.fn(() => derived),
    fundAccountFromPool: vi.fn(),
    returnToPool: vi.fn(),
  };
}

describe("official privacy bridge adapter", () => {
  it("validates and brands the upstream derived EVM identity", () => {
    const upstream = bridgeExports();
    const engine = createStarkwarePrivacyBridgeEngine(upstream);

    expect(
      engine.deriveEvmOwner("signature", 3, "private-launchpad-v1"),
    ).toEqual({
      privateKey: PRIVATE_KEY,
      address: ADDRESS,
    });
    expect(upstream.derivePolygonEoa).toHaveBeenCalledWith(
      "signature",
      3,
      "private-launchpad-v1",
    );
  });

  it("rejects malformed key material before the client can sign", () => {
    expect(() =>
      createStarkwarePrivacyBridgeEngine(
        bridgeExports({ privateKey: "0x12", address: ADDRESS }),
      ).deriveEvmOwner("signature", 0, "private-launchpad-v1"),
    ).toThrow(/private key/);

    expect(() =>
      createStarkwarePrivacyBridgeEngine(
        bridgeExports({ privateKey: PRIVATE_KEY, address: "not-an-address" }),
      ).deriveEvmOwner("signature", 0, "private-launchpad-v1"),
    ).toThrow(/owner address/);
  });
});
