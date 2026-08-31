import { getAddress, isAddressEqual, type Address } from "viem";
import {
  ARBITRUM_CHAIN_ID,
  ARBITRUM_NATIVE_USDC,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_USDG,
} from "@private-launchpad/sdk";

const DEFAULT_MAX_QUOTE_AGE_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface RelayReturnBinding {
  requestId: string;
  account: Address;
  owner: Address;
  depositAddress: Address;
  amount: bigint;
}

export type RelayReturnVerifier = (
  binding: RelayReturnBinding,
) => Promise<void>;

export interface RelayReturnVerifierOptions {
  endpoint?: string;
  apiKey: string;
  fetch?: typeof fetch;
  maxQuoteAgeMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Independently resolves a Relay request and binds the owner-signed USDG
 * transfer to its strict, single-use deposit address before broadcast.
 */
export function createRelayReturnVerifier(
  options: RelayReturnVerifierOptions,
): RelayReturnVerifier {
  const endpoint = relayEndpoint(options.endpoint ?? "https://api.relay.link");
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("RELAY_API_KEY is required for Pons returns");
  const fetchImpl = options.fetch ?? fetch;
  const maxQuoteAgeMs = options.maxQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maxQuoteAgeMs) || maxQuoteAgeMs <= 0) {
    throw new Error("Relay maximum quote age must be a positive integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Relay request timeout must be a positive integer");
  }

  return async (binding) => {
    assertRequestId(binding.requestId);
    const url = new URL("requests/v3", `${endpoint}/`);
    url.searchParams.set("id", binding.requestId);
    url.searchParams.set("limit", "2");
    url.searchParams.set("includeAuthenticatedData", "true");
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-api-key": apiKey,
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await responseJson(response);
    if (!response.ok) {
      throw new Error(
        `Relay request lookup failed with status ${response.status}`,
      );
    }
    validateRelayReturnRequest(body, binding, now(), maxQuoteAgeMs);
  };
}

export function relayReturnVerifierFromEnv(
  env: NodeJS.ProcessEnv,
): RelayReturnVerifier {
  const maxQuoteAgeSeconds = Number(
    env.RELAY_RETURN_MAX_QUOTE_AGE_SECONDS ?? "900",
  );
  if (!Number.isSafeInteger(maxQuoteAgeSeconds) || maxQuoteAgeSeconds <= 0) {
    throw new Error(
      "RELAY_RETURN_MAX_QUOTE_AGE_SECONDS must be a positive integer",
    );
  }
  return createRelayReturnVerifier({
    endpoint: env.RELAY_API_URL?.trim() || "https://api.relay.link",
    apiKey: env.RELAY_API_KEY ?? "",
    maxQuoteAgeMs: maxQuoteAgeSeconds * 1_000,
  });
}

export function validateRelayReturnRequest(
  value: unknown,
  binding: RelayReturnBinding,
  nowMs = Date.now(),
  maxQuoteAgeMs = DEFAULT_MAX_QUOTE_AGE_MS,
): void {
  const root = record(value, "Relay requests response");
  if (!Array.isArray(root.requests)) {
    throw new Error("Relay requests response is missing requests");
  }
  const matches = root.requests.filter((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const id = (candidate as Record<string, unknown>).id;
    return (
      typeof id === "string" &&
      id.toLowerCase() === binding.requestId.toLowerCase()
    );
  });
  if (matches.length !== 1) {
    throw new Error("Relay return request was not found uniquely");
  }

  const request = record(matches[0], "Relay return request");
  const status = string(request.status, "Relay return status");
  if (status !== "waiting" && status !== "pending") {
    throw new Error(`Relay return request is not executable: ${status}`);
  }
  assertAddress(request.user, binding.account, "Relay return user");
  assertAddress(request.refundTo, binding.owner, "Relay return refund address");

  const deposit = record(request.depositAddress, "Relay deposit address");
  assertAddress(
    deposit.address,
    binding.depositAddress,
    "Relay strict deposit address",
  );
  const depositType = deposit.type ?? deposit.depositAddressType;
  if (depositType !== "strict") {
    throw new Error("Relay return must use a strict deposit address");
  }

  const recipient = address(request.recipient, "Relay return recipient");
  if (
    isAddressEqual(recipient, binding.account) ||
    isAddressEqual(recipient, binding.owner)
  ) {
    throw new Error("Relay return recipient must be an isolated account");
  }

  const data = record(request.data, "Relay return data");
  const route = record(data.route, "Relay return route");
  const quoted = record(route.quoted, "Relay quoted route");
  const origin = record(quoted.origin, "Relay quoted origin");
  const originInput = record(origin.inputCurrency, "Relay quoted origin input");
  assertCurrencyAmount(
    originInput,
    ROBINHOOD_CHAIN_ID,
    ROBINHOOD_USDG,
    binding.amount,
    "Relay return input",
  );
  const destination = record(quoted.destination, "Relay quoted destination");
  const destinationOutput = record(
    destination.outputCurrency,
    "Relay quoted destination output",
  );
  assertCurrency(
    destinationOutput,
    ARBITRUM_CHAIN_ID,
    ARBITRUM_NATIVE_USDC,
    "Relay return output",
  );

  const createdAt = Date.parse(
    string(request.createdAt, "Relay quote creation"),
  );
  if (!Number.isFinite(createdAt)) {
    throw new Error("Relay quote creation time is invalid");
  }
  const age = nowMs - createdAt;
  if (age < -60_000 || age > maxQuoteAgeMs) {
    throw new Error("Relay return quote is outside the permitted age window");
  }
}

function assertCurrencyAmount(
  value: Record<string, unknown>,
  chainId: number,
  currency: Address,
  amount: bigint,
  field: string,
): void {
  assertCurrency(value, chainId, currency, field);
  if (string(value.amount, `${field} amount`) !== amount.toString()) {
    throw new Error(`${field} amount does not match the signed transfer`);
  }
}

function assertCurrency(
  value: Record<string, unknown>,
  chainId: number,
  currency: Address,
  field: string,
): void {
  const descriptor = record(value.currency, `${field} currency`);
  if (descriptor.chainId !== chainId) {
    throw new Error(`${field} chain does not match policy`);
  }
  assertAddress(descriptor.address, currency, `${field} currency`);
}

function assertAddress(value: unknown, expected: Address, field: string): void {
  if (!isAddressEqual(address(value, field), expected)) {
    throw new Error(`${field} does not match policy`);
  }
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string") throw new Error(`${field} must be an address`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${field} must be an address`);
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function assertRequestId(value: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Relay request ID must be 32-byte hex");
  }
}

function relayEndpoint(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error("Relay API URL must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Relay API URL must not contain credentials");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Relay request lookup returned invalid JSON");
  }
}
