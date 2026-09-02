import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { createRelayQuoteAttestation } from "./relay-quote-attestation.js";
import {
  createRelayReturnVerifier,
  type RelayReturnBinding,
} from "./relay-requests.js";

const REQUEST_ID = `0x${"ab".repeat(32)}`;
const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const OWNER = "0x2222222222222222222222222222222222222222" as Address;
const DEPOSIT = "0x3333333333333333333333333333333333333333" as Address;
const RECIPIENT = "0x4444444444444444444444444444444444444444" as Address;
const KEY = "11".repeat(32);
const NOW = Date.parse("2026-08-31T10:00:00.000Z");

function attestation(overrides: Partial<RelayReturnBinding> = {}): string {
  return createRelayQuoteAttestation(KEY, {
    requestId: overrides.requestId ?? REQUEST_ID,
    account: overrides.account ?? ACCOUNT,
    owner: overrides.owner ?? OWNER,
    recipient: RECIPIENT,
    depositAddress: overrides.depositAddress ?? DEPOSIT,
    amount: overrides.amount ?? 25_000_000n,
    issuedAt: NOW - 60_000,
    expiresAt: NOW + 60_000,
  });
}

function binding(
  overrides: Partial<RelayReturnBinding> = {},
): RelayReturnBinding {
  return {
    requestId: REQUEST_ID,
    quoteAttestation: attestation(),
    account: ACCOUNT,
    owner: OWNER,
    depositAddress: DEPOSIT,
    amount: 25_000_000n,
    ...overrides,
  };
}

describe("Relay return request verification", () => {
  it("accepts the exact short-lived quote sealed by the trusted proxy", async () => {
    const verify = createRelayReturnVerifier({
      attestationKey: KEY,
      now: () => NOW,
    });
    await expect(verify(binding())).resolves.toBeUndefined();
  });

  it("rejects changes to the request, account, deposit address, or amount", async () => {
    const verify = createRelayReturnVerifier({
      attestationKey: KEY,
      now: () => NOW,
    });
    await expect(
      verify(binding({ requestId: `0x${"cd".repeat(32)}` })),
    ).rejects.toThrow(/request ID/);
    await expect(
      verify(
        binding({
          account: "0x5555555555555555555555555555555555555555",
        }),
      ),
    ).rejects.toThrow(/user/);
    await expect(
      verify(
        binding({
          depositAddress: "0x5555555555555555555555555555555555555555",
        }),
      ),
    ).rejects.toThrow(/strict deposit address/);
    await expect(verify(binding({ amount: 1n }))).rejects.toThrow(/amount/);
  });

  it("rejects tampered or expired attestations", async () => {
    const verify = createRelayReturnVerifier({
      attestationKey: KEY,
      now: () => NOW,
    });
    const valid = attestation();
    await expect(
      verify(binding({ quoteAttestation: `${valid.slice(0, -1)}A` })),
    ).rejects.toThrow(/authentication/);
    const expired = createRelayQuoteAttestation(KEY, {
      requestId: REQUEST_ID,
      account: ACCOUNT,
      owner: OWNER,
      recipient: RECIPIENT,
      depositAddress: DEPOSIT,
      amount: 25_000_000n,
      issuedAt: NOW - 120_000,
      expiresAt: NOW - 60_000,
    });
    await expect(
      verify(binding({ quoteAttestation: expired })),
    ).rejects.toThrow(/expired/);
  });
});
