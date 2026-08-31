import { Buffer } from "node:buffer";

const REDIS_TIMEOUT_MS = 10_000;
const ENCRYPTION_VERSION = "v1";

export interface StarkscanProverStateStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

export interface StarkscanProverStateEnvironment {
  readonly [name: string]: string | undefined;
  readonly PROVER_STATE_REST_URL?: string;
  readonly PROVER_STATE_REST_TOKEN?: string;
  readonly PROVER_STATE_ENCRYPTION_KEY?: string;
  readonly KV_REST_API_URL?: string;
  readonly KV_REST_API_TOKEN?: string;
}

export interface StarkscanProverStateStoreOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly encryptionKey: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Creates the production proof-state store. Values are encrypted before they
 * leave the function; the Redis-compatible service sees only opaque blobs and
 * SHA-256-derived record keys.
 */
export function createStarkscanProverStateStore(
  options: StarkscanProverStateStoreOptions,
): StarkscanProverStateStore {
  const endpoint = restEndpoint(options.endpoint);
  const token = required(options.token, "PROVER_STATE_REST_TOKEN");
  const keyBytes = encryptionKey(options.encryptionKey);
  const fetchImpl = options.fetchImpl ?? fetch;

  const command = async (parts: readonly string[]): Promise<unknown> => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(parts),
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("proof state store returned invalid JSON");
    }
    const body = record(payload, "proof state store response");
    if (!response.ok || body.error !== undefined) {
      throw new Error(`proof state store request failed (${response.status})`);
    }
    return body.result;
  };

  return {
    async get(key) {
      const value = await command(["GET", stateKey(key)]);
      if (value === null || value === undefined) return undefined;
      if (typeof value !== "string") {
        throw new Error("proof state store returned a non-string value");
      }
      return decryptJson(value, keyBytes);
    },
    async set(key, value, ttlSeconds) {
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
        throw new Error("proof state TTL must be a positive integer");
      }
      const encrypted = await encryptJson(value, keyBytes);
      await command([
        "SET",
        stateKey(key),
        encrypted,
        "EX",
        String(ttlSeconds),
      ]);
    },
  };
}

export function createStarkscanProverStateStoreFromEnv(
  environment: StarkscanProverStateEnvironment,
  fetchImpl?: typeof fetch,
): StarkscanProverStateStore {
  return createStarkscanProverStateStore({
    endpoint: required(
      environment.PROVER_STATE_REST_URL ?? environment.KV_REST_API_URL,
      "PROVER_STATE_REST_URL",
    ),
    token: required(
      environment.PROVER_STATE_REST_TOKEN ?? environment.KV_REST_API_TOKEN,
      "PROVER_STATE_REST_TOKEN",
    ),
    encryptionKey: required(
      environment.PROVER_STATE_ENCRYPTION_KEY,
      "PROVER_STATE_ENCRYPTION_KEY",
    ),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/** Process-local implementation for Vite development and deterministic tests. */
export function createMemoryStarkscanProverStateStore(
  now: () => number = Date.now,
): StarkscanProverStateStore {
  const values = new Map<
    string,
    { readonly value: unknown; readonly expiresAt: number }
  >();
  return {
    async get(key) {
      const entry = values.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        values.delete(key);
        return undefined;
      }
      return structuredClone(entry.value);
    },
    async set(key, value, ttlSeconds) {
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
        throw new Error("proof state TTL must be a positive integer");
      }
      values.set(key, {
        value: structuredClone(value),
        expiresAt: now() + ttlSeconds * 1_000,
      });
    },
  };
}

async function encryptJson(
  value: unknown,
  keyBytes: Uint8Array,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(keyBytes).buffer,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  return `${ENCRYPTION_VERSION}.${base64Url(iv)}.${base64Url(ciphertext)}`;
}

async function decryptJson(
  value: string,
  keyBytes: Uint8Array,
): Promise<unknown> {
  const [version, ivValue, ciphertextValue, ...remainder] = value.split(".");
  if (
    version !== ENCRYPTION_VERSION ||
    !ivValue ||
    !ciphertextValue ||
    remainder.length > 0
  ) {
    throw new Error("proof state ciphertext has an invalid envelope");
  }
  const iv = fromBase64Url(ivValue, "proof state IV");
  if (iv.length !== 12) throw new Error("proof state IV has an invalid length");
  const ciphertext = fromBase64Url(ciphertextValue, "proof state ciphertext");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(keyBytes).buffer,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Uint8Array.from(iv) },
      key,
      Uint8Array.from(ciphertext),
    );
  } catch {
    throw new Error("proof state ciphertext failed authentication");
  }
  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  } catch {
    throw new Error("proof state plaintext is invalid JSON");
  }
}

function encryptionKey(value: string): Uint8Array {
  const trimmed = required(value, "PROVER_STATE_ENCRYPTION_KEY").trim();
  let bytes: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    bytes = Uint8Array.from(
      trimmed.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)),
    );
  } else {
    bytes = fromBase64Url(trimmed, "PROVER_STATE_ENCRYPTION_KEY");
  }
  if (bytes.length !== 32) {
    throw new Error("PROVER_STATE_ENCRYPTION_KEY must encode exactly 32 bytes");
  }
  return bytes;
}

function restEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(required(value, "PROVER_STATE_REST_URL"));
  } catch {
    throw new Error("PROVER_STATE_REST_URL must be a valid URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      "PROVER_STATE_REST_URL must be credential-free HTTPS without query or fragment",
    );
  }
  return endpoint;
}

function stateKey(value: string): string {
  if (!/^[a-z0-9:_-]{16,180}$/.test(value)) {
    throw new Error("proof state key is invalid");
  }
  return `privatepons:${value}`;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string, field: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${field} must use unpadded base64url`);
  }
  try {
    return new Uint8Array(Buffer.from(value, "base64url"));
  } catch {
    throw new Error(`${field} is not valid base64url`);
  }
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
