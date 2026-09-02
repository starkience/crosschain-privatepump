import { isAddressEqual, type Address } from "viem";
import { verifyRelayQuoteAttestation } from "./relay-quote-attestation.js";

export interface RelayReturnBinding {
  requestId: string;
  quoteAttestation: string;
  account: Address;
  owner: Address;
  depositAddress: Address;
  amount: bigint;
}

export type RelayReturnVerifier = (
  binding: RelayReturnBinding,
) => Promise<void>;

export interface RelayReturnVerifierOptions {
  attestationKey: string;
  now?: () => number;
}

/**
 * Verifies the short-lived quote attestation issued by the trusted Relay
 * proxy. Relay does not add a quote to /requests until its deposit is
 * broadcast, so querying /requests before authorizing that deposit is a
 * circular check and rejects every legitimate return.
 */
export function createRelayReturnVerifier(
  options: RelayReturnVerifierOptions,
): RelayReturnVerifier {
  const key = options.attestationKey;
  const now = options.now ?? Date.now;
  return async (binding) => {
    assertRequestId(binding.requestId);
    const quote = verifyRelayQuoteAttestation(
      key,
      binding.quoteAttestation,
      now(),
    );
    if (quote.requestId !== binding.requestId.toLowerCase()) {
      throw new Error("Relay return request ID does not match its attestation");
    }
    assertAddress(quote.account, binding.account, "Relay return user");
    assertAddress(quote.owner, binding.owner, "Relay return refund address");
    assertAddress(
      quote.depositAddress,
      binding.depositAddress,
      "Relay strict deposit address",
    );
    if (quote.amount !== binding.amount.toString()) {
      throw new Error("Relay return amount does not match its attestation");
    }
    if (
      isAddressEqual(quote.recipient, binding.account) ||
      isAddressEqual(quote.recipient, binding.owner)
    ) {
      throw new Error("Relay return recipient must be an isolated account");
    }
  };
}

export function relayReturnVerifierFromEnv(
  env: NodeJS.ProcessEnv,
): RelayReturnVerifier {
  return createRelayReturnVerifier({
    attestationKey: required(
      env.RELAY_QUOTE_ATTESTATION_KEY,
      "RELAY_QUOTE_ATTESTATION_KEY",
    ),
  });
}

function assertAddress(value: Address, expected: Address, field: string): void {
  if (!isAddressEqual(value, expected)) {
    throw new Error(`${field} does not match policy`);
  }
}

function assertRequestId(value: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Relay request ID must be 32-byte hex");
  }
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required`);
  return value.trim();
}
