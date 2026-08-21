import { getAddress, isAddress, type Hex } from "viem";
import type { PrivacyBridgeEngine } from "./types.js";

export interface StarkwarePrivacyBridgeExports {
  derivePolygonEoa(
    signature: string,
    accountIndex: number,
    channel?: string,
  ): { privateKey: string; address: string };
  fundAccountFromPool: PrivacyBridgeEngine["fundAccountFromPool"];
  returnToPool: PrivacyBridgeEngine["returnToPool"];
}

/**
 * Adapts the official StarkWare bridge package to this SDK and validates the
 * package's deliberately unbranded string address/key outputs at runtime.
 */
export function createStarkwarePrivacyBridgeEngine(
  bridge: StarkwarePrivacyBridgeExports,
): PrivacyBridgeEngine {
  return {
    deriveEvmOwner(signature, accountIndex, channel) {
      const derived = bridge.derivePolygonEoa(signature, accountIndex, channel);
      if (!isAddress(derived.address)) {
        throw new Error("privacy bridge derived an invalid EVM owner address");
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(derived.privateKey)) {
        throw new Error(
          "privacy bridge derived an invalid EVM owner private key",
        );
      }
      return {
        address: getAddress(derived.address),
        privateKey: derived.privateKey as Hex,
      };
    },
    fundAccountFromPool: (args) => bridge.fundAccountFromPool(args),
    returnToPool: (args) => bridge.returnToPool(args),
  };
}
