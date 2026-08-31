import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildClankerV4TokenConfig,
  CLANKER_V4_FACTORY,
  createClankerV4UsdcPool,
  prepareClankerV4Launch,
} from "./clanker-v4.js";

const PRIVATE_ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const BUILDER = "0x2222222222222222222222222222222222222222" as Address;

describe("Clanker V4 adapter", () => {
  it("forces creator roles onto the private account and splits builder rewards", () => {
    const token = buildClankerV4TokenConfig(
      84532,
      {
        name: "Private Meme",
        symbol: "pmeme",
        description: "Public token metadata",
        creatorRewardBps: 7_500,
        vault: {
          percentage: 10,
          lockupDuration: 7 * 24 * 60 * 60,
        },
      },
      { account: PRIVATE_ACCOUNT },
      { builder: { admin: BUILDER, recipient: BUILDER } },
    );

    expect(token.tokenAdmin).toBe(PRIVATE_ACCOUNT);
    expect(token.context).toEqual({ interface: "Private Clanker" });
    expect(token.vault?.recipient).toBe(PRIVATE_ACCOUNT);
    expect(token.rewards?.recipients).toEqual([
      {
        admin: PRIVATE_ACCOUNT,
        recipient: PRIVATE_ACCOUNT,
        bps: 7_500,
        token: "Both",
      },
      { admin: BUILDER, recipient: BUILDER, bps: 2_500, token: "Both" },
    ]);
  });

  it("uses the official SDK to prepare the current V4 deploy call", async () => {
    const prepared = await prepareClankerV4Launch(
      84532,
      {
        name: "Private Meme",
        symbol: "PMEME",
        salt: `0x${"33".repeat(32)}`,
      },
      { account: PRIVATE_ACCOUNT },
    );

    expect(prepared.call.target).toBe(CLANKER_V4_FACTORY[84532]);
    expect(prepared.call.value).toBe(0n);
    expect(prepared.expectedToken).toMatch(/^0x[0-9A-Fa-f]{40}$/);
    expect(prepared.call.data).not.toBe("0x");
  });

  it("builds a USDC pool that can accept the private initial buy directly", () => {
    const usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
    const pool = createClankerV4UsdcPool(usdc);
    const token = buildClankerV4TokenConfig(
      84532,
      { name: "Private Meme", symbol: "PMEME", pool },
      { account: PRIVATE_ACCOUNT },
    );

    expect(token.pool).toEqual({
      pairedToken: usdc,
      tickIfToken0IsClanker: -437_600,
      tickSpacing: 200,
      positions: [
        { tickLower: -437_600, tickUpper: -322_400, positionBps: 10_000 },
      ],
    });
  });

  it("predicts the same token address when the launch salt is reused", async () => {
    const intent = {
      name: "Recoverable Meme",
      symbol: "RCVR",
      salt: `0x${"55".repeat(32)}` as const,
    };
    const first = await prepareClankerV4Launch(84532, intent, {
      account: PRIVATE_ACCOUNT,
    });
    const second = await prepareClankerV4Launch(84532, intent, {
      account: PRIVATE_ACCOUNT,
    });
    expect(second.expectedToken).toBe(first.expectedToken);
  });

  it("appends a pre-encoded Base builder code suffix", async () => {
    const prepared = await prepareClankerV4Launch(
      8453,
      { name: "Private Meme", symbol: "PMEME" },
      { account: PRIVATE_ACCOUNT },
      { dataSuffix: "0xdeadbeef" },
    );
    expect(prepared.call.data.endsWith("deadbeef")).toBe(true);
  });

  it("rejects a reward split without a builder recipient", () => {
    expect(() =>
      buildClankerV4TokenConfig(
        8453,
        { name: "Private Meme", symbol: "PMEME", creatorRewardBps: 8_000 },
        { account: PRIVATE_ACCOUNT },
      ),
    ).toThrow(/builder reward recipient/);
  });
});
