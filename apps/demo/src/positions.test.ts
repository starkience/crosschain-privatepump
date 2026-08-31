import { afterEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  allocateAccountIndex,
  clearPrivateBalanceRest,
  loadPrivateBalanceRest,
  loadPrivatePositions,
  mergeRecoveredPositions,
  migratePrivateRecoveryStorage,
  savePrivateBalanceRest,
  savePrivatePositions,
  type PrivatePosition,
} from "./positions.js";

const ROOT = "0x1111111111111111111111111111111111111111" as Address;
const SCOPE = `0x${"aa".repeat(32)}` as Hex;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;

afterEach(() => localStorage.clear());

describe("private position recovery metadata", () => {
  it("survives refresh without storing secret wallet material", () => {
    const position: PrivatePosition = {
      id: "position-1",
      kind: "trade",
      name: "Night Market",
      symbol: "NITE",
      token: TOKEN,
      accountIndex: 17,
      account: ACCOUNT,
      status: "held",
      usdcCommitted: "25000000",
      tokenAmount: "1240000000000000000000000",
      buyTxHash: `0x${"44".repeat(32)}`,
      createdAt: 10,
      updatedAt: 20,
    };

    savePrivatePositions(84532, SCOPE, [position]);
    expect(loadPrivatePositions(84532, SCOPE)).toEqual([position]);
    const serialized = localStorage.getItem(
      `privatepons-private-positions-v2:84532:${SCOPE}`,
    )!;
    expect(serialized).not.toMatch(
      /privateKey|signature|viewingKey|commitment/i,
    );
  });

  it("allocates a different account index for each saved token position", () => {
    const first = allocateAccountIndex([]);
    const next = allocateAccountIndex([
      {
        id: "position-1",
        kind: "trade",
        name: "Token",
        symbol: "TOKEN",
        token: TOKEN,
        accountIndex: first,
        account: ACCOUNT,
        status: "held",
        usdcCommitted: "25000000",
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
    expect(next).not.toBe(first);
  });

  it("restores only non-secret deposit pacing metadata after refresh", () => {
    savePrivateBalanceRest(84532, SCOPE, {
      amount: "25000000",
      readyAt: 1_800_000,
    });
    expect(loadPrivateBalanceRest(84532, SCOPE)).toEqual({
      amount: "25000000",
      readyAt: 1_800_000,
    });
    const serialized = localStorage.getItem(
      `privatepons-private-balance-rest-v2:84532:${SCOPE}`,
    )!;
    expect(serialized).not.toMatch(/privateKey|signature|viewingKey|note/i);

    clearPrivateBalanceRest(84532, SCOPE);
    expect(loadPrivateBalanceRest(84532, SCOPE)).toBeUndefined();
  });

  it("migrates and removes legacy root-address storage keys", () => {
    const legacyKey =
      "plank-private-positions-v1:84532:0x1111111111111111111111111111111111111111";
    localStorage.setItem(
      legacyKey,
      JSON.stringify({ version: 1, positions: [] }),
    );

    migratePrivateRecoveryStorage(84532, ROOT, SCOPE);

    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(loadPrivatePositions(84532, SCOPE)).toEqual([]);
    expect(
      [...Array(localStorage.length).keys()]
        .map((index) => localStorage.key(index))
        .join("\n"),
    ).not.toContain(ROOT.toLowerCase());
  });

  it("merges an onchain recovery into the existing public position history", () => {
    const saved: PrivatePosition = {
      id: "local-position",
      kind: "trade",
      name: "Cached name",
      symbol: "OLD",
      token: TOKEN,
      accountIndex: 17,
      account: ACCOUNT,
      status: "buy-failed",
      usdcCommitted: "25000000",
      buyTxHash: `0x${"44".repeat(32)}`,
      lastError: "stale error",
      createdAt: 10,
      updatedAt: 20,
    };
    const recovered: PrivatePosition = {
      id: "onchain-position",
      kind: "trade",
      name: "Onchain name",
      symbol: "LIVE",
      token: TOKEN,
      accountIndex: 17,
      account: ACCOUNT,
      status: "held",
      usdcCommitted: "0",
      tokenAmount: "1240000000000000000000000",
      createdAt: 12,
      updatedAt: 30,
    };

    expect(mergeRecoveredPositions([saved], [recovered])).toEqual([
      {
        ...recovered,
        id: "local-position",
        usdcCommitted: "25000000",
        buyTxHash: saved.buyTxHash,
        createdAt: 10,
      },
    ]);
  });
});
