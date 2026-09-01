import type { StarkscanProverStateStore } from "./starkscan-prover-store.js";
import {
  starkscanRequestDigest,
  validateMainnetProveRequest,
} from "./starkscan-prover-relay.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 270_000;
const RESULT_CACHE_TTL_SECONDS = 2 * 60;
const SCREENING_MAX_AGE_SECONDS = 5 * 60;
const SCREENING_SUBMISSION_MARGIN_SECONDS = 45;

export interface StarkwareProverRelayOptions {
  readonly endpoint: string;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly stateStore?: StarkscanProverStateStore;
}

export interface StarkwareProverRelayResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly retryAfter?: string;
}

interface StoredResult {
  readonly version: 1;
  readonly result: unknown;
}

/**
 * Relays the Privacy SDK's synchronous JSON-RPC call to StarkWare's mainnet
 * transaction prover. Successful results are briefly encrypted in the shared
 * proof-state store so a browser retry after response loss does not recompute
 * the proof. Timeout delivery remains unknown and is never retried by this
 * relay.
 */
export async function relayStarkwareProverRequest(
  value: unknown,
  options: StarkwareProverRelayOptions,
): Promise<StarkwareProverRelayResponse> {
  const request = validateMainnetProveRequest(value);
  const endpoint = proverEndpoint(options.endpoint);
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    "StarkWare request timeout",
  );
  const now = options.now ?? Date.now;
  const digest = await starkscanRequestDigest(request.params);
  const cacheKey = `starkware:${digest}:result`;
  const cached = options.stateStore
    ? storedResult(await options.stateStore.get(cacheKey))
    : undefined;
  if (cached) return success(request.id, cached.result);

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    if (isTimeout(error)) {
      return {
        status: 504,
        body: {
          error:
            "StarkWare prover did not return before the request deadline. Proof delivery is unknown; do not start another public deposit.",
        },
      };
    }
    throw error;
  }

  const payload = await responseObject(response);
  if (!response.ok) {
    return {
      status: response.status,
      body: payload,
      ...(response.headers.get("retry-after")
        ? { retryAfter: response.headers.get("retry-after")! }
        : {}),
    };
  }

  const rpc = rpcResponse(payload, request.id);
  if ("result" in rpc && options.stateStore) {
    const ttlSeconds = resultTtlSeconds(rpc.result, now());
    if (ttlSeconds <= 0) {
      return {
        status: 503,
        body: {
          error:
            "StarkWare screening attestation is too close to expiry; rebuild the proof request",
        },
        retryAfter: "1",
      };
    }
    await options.stateStore.set(
      cacheKey,
      { version: 1, result: rpc.result } satisfies StoredResult,
      ttlSeconds,
    );
  }
  return { status: 200, body: rpc };
}

function rpcResponse(
  value: Record<string, unknown>,
  id: string | number | null,
): Record<string, unknown> {
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (value.jsonrpc !== "2.0" || hasResult === hasError) {
    throw new Error("StarkWare prover returned an invalid JSON-RPC response");
  }
  if (hasError) {
    const error = record(value.error, "StarkWare prover error");
    if (typeof error.code !== "number" || typeof error.message !== "string") {
      throw new Error("StarkWare prover returned an invalid JSON-RPC error");
    }
    return { jsonrpc: "2.0", id, error };
  }
  return { jsonrpc: "2.0", id, result: value.result };
}

function success(
  id: string | number | null,
  result: unknown,
): StarkwareProverRelayResponse {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

async function responseObject(
  response: Response,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("StarkWare prover returned invalid JSON");
  }
  return record(value, "StarkWare prover response");
}

function storedResult(value: unknown): StoredResult | undefined {
  if (value === undefined) return undefined;
  const stored = record(value, "stored StarkWare proof result");
  if (
    stored.version !== 1 ||
    !Object.prototype.hasOwnProperty.call(stored, "result")
  ) {
    throw new Error("stored StarkWare proof result is invalid");
  }
  return stored as unknown as StoredResult;
}

function resultTtlSeconds(result: unknown, nowMs: number): number {
  const issuedAt = screeningIssuedAt(result);
  if (issuedAt === undefined) return RESULT_CACHE_TTL_SECONDS;
  return Math.max(
    0,
    Math.min(
      RESULT_CACHE_TTL_SECONDS,
      issuedAt +
        SCREENING_MAX_AGE_SECONDS -
        SCREENING_SUBMISSION_MARGIN_SECONDS -
        Math.floor(nowMs / 1_000),
    ),
  );
}

function screeningIssuedAt(result: unknown): number | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const additionalData = (result as Record<string, unknown>).additional_data;
  if (
    !additionalData ||
    typeof additionalData !== "object" ||
    Array.isArray(additionalData)
  ) {
    return undefined;
  }
  const signature = (additionalData as Record<string, unknown>).signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) {
    return undefined;
  }
  const issuedAt = (signature as Record<string, unknown>).issued_at;
  return typeof issuedAt === "number" && Number.isSafeInteger(issuedAt)
    ? issuedAt
    : undefined;
}

function proverEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("STRK20_MAINNET_PROVER_URL must be a valid URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      "STRK20_MAINNET_PROVER_URL must be credential-free HTTPS without query or fragment",
    );
  }
  return endpoint;
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
