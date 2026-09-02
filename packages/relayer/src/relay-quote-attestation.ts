import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { getAddress, isAddress, type Address } from "viem";

const ATTESTATION_VERSION = 1;
const MAX_CLOCK_SKEW_MS = 60_000;

export interface RelayQuoteAttestationClaims {
  version: 1;
  requestId: string;
  account: Address;
  owner: Address;
  recipient: Address;
  depositAddress: Address;
  amount: string;
  issuedAt: number;
  expiresAt: number;
}

export interface CreateRelayQuoteAttestationArgs {
  requestId: string;
  account: Address;
  owner: Address;
  recipient: Address;
  depositAddress: Address;
  amount: bigint;
  issuedAt: number;
  expiresAt: number;
}

/**
 * Seals the exact Relay quote returned by the trusted same-origin proxy. The
 * browser can carry this token to the policy relayer but cannot change the
 * destination, amount, or owner without invalidating the MAC.
 */
export function createRelayQuoteAttestation(
  key: string,
  args: CreateRelayQuoteAttestationArgs,
): string {
  const claims = normalizeClaims({
    version: ATTESTATION_VERSION,
    requestId: args.requestId,
    account: args.account,
    owner: args.owner,
    recipient: args.recipient,
    depositAddress: args.depositAddress,
    amount: args.amount.toString(),
    issuedAt: args.issuedAt,
    expiresAt: args.expiresAt,
  });
  if (claims.expiresAt <= claims.issuedAt) {
    throw new Error("Relay quote attestation expiry must follow issuance");
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = mac(attestationKey(key), payload).toString("base64url");
  return `v1.${payload}.${signature}`;
}

export function verifyRelayQuoteAttestation(
  key: string,
  token: string,
  nowMs = Date.now(),
): RelayQuoteAttestationClaims {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
    throw new Error("Relay quote attestation has an invalid envelope");
  }
  const payload = parts[1];
  const supplied = decodeBase64Url(parts[2], "Relay quote attestation MAC");
  const expected = mac(attestationKey(key), payload);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new Error("Relay quote attestation failed authentication");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      decodeBase64Url(payload, "Relay quote attestation payload").toString(
        "utf8",
      ),
    ) as unknown;
  } catch {
    throw new Error("Relay quote attestation payload is invalid JSON");
  }
  const claims = normalizeClaims(parsed);
  if (claims.issuedAt > nowMs + MAX_CLOCK_SKEW_MS) {
    throw new Error("Relay quote attestation was issued in the future");
  }
  if (claims.expiresAt < nowMs) {
    throw new Error("Relay quote attestation has expired");
  }
  return claims;
}

function normalizeClaims(value: unknown): RelayQuoteAttestationClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Relay quote attestation claims must be an object");
  }
  const claims = value as Record<string, unknown>;
  if (claims.version !== ATTESTATION_VERSION) {
    throw new Error("Relay quote attestation version is unsupported");
  }
  if (
    typeof claims.requestId !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(claims.requestId)
  ) {
    throw new Error("Relay quote attestation request ID is invalid");
  }
  if (
    typeof claims.amount !== "string" ||
    !/^[1-9][0-9]*$/.test(claims.amount)
  ) {
    throw new Error("Relay quote attestation amount is invalid");
  }
  if (
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt)
  ) {
    throw new Error("Relay quote attestation timestamps are invalid");
  }
  return {
    version: ATTESTATION_VERSION,
    requestId: claims.requestId.toLowerCase(),
    account: address(claims.account, "account"),
    owner: address(claims.owner, "owner"),
    recipient: address(claims.recipient, "recipient"),
    depositAddress: address(claims.depositAddress, "deposit address"),
    amount: claims.amount,
    issuedAt: claims.issuedAt as number,
    expiresAt: claims.expiresAt as number,
  };
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw new Error(`Relay quote attestation ${field} is invalid`);
  }
  return getAddress(value);
}

function attestationKey(value: string): Buffer {
  const trimmed = value.trim();
  let bytes: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    bytes = Buffer.from(trimmed, "hex");
  } else if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    bytes = Buffer.from(trimmed, "base64url");
  } else {
    throw new Error("RELAY_QUOTE_ATTESTATION_KEY has an invalid encoding");
  }
  if (bytes.length !== 32) {
    throw new Error("RELAY_QUOTE_ATTESTATION_KEY must encode exactly 32 bytes");
  }
  return bytes;
}

function decodeBase64Url(value: string, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${field} is not base64url`);
  }
  return Buffer.from(value, "base64url");
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key)
    .update("privatepons-relay-return-v1\0")
    .update(payload)
    .digest();
}
