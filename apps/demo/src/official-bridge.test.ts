import { describe, expect, it, vi } from "vitest";
import {
  validateOfficialBridgeManifest,
  validateOfficialBridgeModule,
} from "./official-bridge.js";

const manifest = {
  schemaVersion: 1,
  module: "privacy-bridge-v0.1.22.mjs",
  sha256: "a".repeat(64),
  sdk: { commit: "efc61cbbdab5b714b5cf915f9735d88948e2ea82" },
  bridge: { commit: "3e95694b997069c47eff52cd576af0bb3e03612d" },
};

describe("official bridge runtime loader", () => {
  it("accepts only the bridge surface consumed by the plugin", () => {
    const bridge = {
      derivePolygonEoa: vi.fn(),
      fundAccountFromPool: vi.fn(),
      returnToPool: vi.fn(),
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
  });
});
