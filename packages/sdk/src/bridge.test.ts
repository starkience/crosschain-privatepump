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
    deriveStarknetPrivateKey: vi.fn(() => "0xstarkprivate"),
    deriveStarknetAccount: vi.fn(() => ({ address: "0xstarkaccount" })),
    deriveViewingKey: vi.fn(() => 7n),
    deriveAccountNonce: vi.fn(() => 9n),
    discoverPrivateBalanceForAddress: vi.fn(async () => 25_000_000n),
    readUndepositedResidual: vi.fn(async () => 10_000_000n),
    getActiveConfig: vi.fn(() => ({ ozClassHash: "0xclasshash" })),
    derivePolygonEoa: vi.fn(() => derived),
    fetchForwardMaxFee: vi.fn(async () => ({
      maxFee: 10n,
      forwardFee: 8n,
      protocolFee: 2n,
      finalityThreshold: 1_000,
    })),
    bridgeOut: vi.fn(async (args) => ({
      burnTxHash: "0xburn",
      mintRecipient: await args.resolveDepositWallet(),
      eoaAddress: ADDRESS,
      commitmentH: 11n,
    })),
    sendPrivateToStarknet: vi.fn(),
    moveIntoPool: vi.fn(),
    cashOut: vi.fn(),
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

  it("recovers private balance through viewing-key note discovery", async () => {
    const upstream = bridgeExports();
    const engine = createStarkwarePrivacyBridgeEngine(upstream);

    await expect(engine.readPrivateBalance("0xsignature")).resolves.toBe(
      25_000_000n,
    );
    expect(upstream.discoverPrivateBalanceForAddress).toHaveBeenCalledWith({
      snAddress: "0xstarkaccount",
      viewingKey: 7n,
    });
  });

  it("finds USDC awaiting the final STRK20 pool step", async () => {
    const upstream = bridgeExports();
    const engine = createStarkwarePrivacyBridgeEngine(upstream);

    await expect(engine.readPendingDeposit("0xsignature")).resolves.toBe(
      10_000_000n,
    );
    expect(upstream.readUndepositedResidual).toHaveBeenCalledWith(
      "0xstarkaccount",
    );
  });

  it("derives the nonce in memory and preserves a strict Relay deposit", async () => {
    const upstream = bridgeExports();
    const engine = createStarkwarePrivacyBridgeEngine(upstream);
    const fee = await engine.quoteCctpOut!({
      amount: 1_000n,
      destinationDomain: 3,
      fast: true,
    });
    const result = await engine.bridgeOutToDeposit!({
      signature: "0x1234",
      accountIndex: 4,
      amount: 1_000n,
      destination: "0x2222222222222222222222222222222222222222",
      destinationChainId: 42161,
      channel: "private-launchpad-v1",
      fee,
    });

    expect(result.mintRecipient).toBe(
      "0x2222222222222222222222222222222222222222",
    );
    expect(upstream.deriveAccountNonce).toHaveBeenCalledWith(
      7n,
      4,
      "private-launchpad-v1",
    );
    expect(upstream.bridgeOut).toHaveBeenCalledWith(
      expect.objectContaining({
        accountNonce: 9n,
        maxFee: 10n,
        minFinalityThreshold: 1_000,
        quotedFinalityThreshold: 1_000,
        destChainId: 42161,
      }),
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
