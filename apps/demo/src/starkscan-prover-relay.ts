import type { StarkscanProverStateStore } from "./starkscan-prover-store.js";

const DEFAULT_MAX_WAIT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
const CURSOR_TTL_SECONDS = 24 * 60 * 60;
const TERMINAL_TTL_SECONDS = 5 * 60;
const SCREENING_MAX_AGE_SECONDS = 5 * 60;
const SCREENING_SUBMISSION_MARGIN_SECONDS = 45;
const JOB_ID_PATTERN = /^prv_[a-z0-9]{24,40}$/;
const MAINNET_POOL_ADDRESS =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

type StarkscanStatus =
  | "queued"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "unavailable"
  | "unknown_delivery";

interface StarkscanJob {
  readonly jobId: string;
  readonly status: StarkscanStatus;
  readonly terminal: boolean;
  readonly pollAfterSeconds?: number;
  readonly result?: unknown;
  readonly resultUnavailableReason?: string;
  readonly error?: unknown;
}

interface StoredCursor {
  readonly version: 1;
  readonly attempt: number;
  readonly updatedAt: number;
  readonly jobId?: string;
  readonly status?: StarkscanStatus;
}

export interface StarkscanProverRelayOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly poolAddress?: string;
  readonly maxWaitMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly stateStore?: StarkscanProverStateStore;
}

export interface StarkscanProverRelayResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly retryAfter?: string;
}

export interface MainnetProveRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly method: "starknet_proveTransaction";
  readonly params: {
    readonly block_id: unknown;
    readonly transaction: Record<string, unknown>;
  };
}

/**
 * Adapts the pinned Privacy SDK's synchronous `starknet_proveTransaction`
 * JSON-RPC call to Starkscan's asynchronous mainnet proving jobs. The browser
 * never receives the Starkscan credential or a job identifier.
 */
export async function relayStarkscanProverRequest(
  value: unknown,
  options: StarkscanProverRelayOptions,
): Promise<StarkscanProverRelayResponse> {
  const request = validateMainnetProveRequest(
    value,
    options.poolAddress ?? MAINNET_POOL_ADDRESS,
  );
  const endpoint = proverEndpoint(options.endpoint);
  if (!options.apiKey) throw new Error("STARKSCAN_API_KEY is required");
  const maxWaitMs = positiveInteger(
    options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    "Starkscan maximum wait",
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const deadline = now() + maxWaitMs;
  const digest = await starkscanRequestDigest(request.params);
  const state = options.stateStore
    ? await loadStoredAttempt(options.stateStore, digest, request.id, now())
    : undefined;
  if (state?.response) return state.response;
  const attempt = state?.attempt ?? 0;
  const idempotencyKey = starkscanIdempotencyKeyFromDigest(digest, attempt);

  let response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-starkscan-api-key": options.apiKey,
    },
    body: JSON.stringify(request.params),
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let payload = await responseObject(response, "Starkscan proof submission");
  if (!response.ok) return upstreamFailure(response, payload);
  let job = parseJob(payload);
  if (options.stateStore) {
    const stored = await persistJob(
      options.stateStore,
      digest,
      attempt,
      job,
      request.id,
      now(),
    );
    if (stored) return stored;
  }

  while (!job.terminal) {
    const delay = Math.max(
      250,
      Math.min((job.pollAfterSeconds ?? 10) * 1_000, 30_000),
    );
    if (now() + delay >= deadline) {
      return {
        status: 503,
        body: {
          error: "Starkscan proof is still in progress",
          jobId: job.jobId,
          proofStatus: job.status,
        },
        retryAfter: String(Math.ceil(delay / 1_000)),
      };
    }
    await sleep(delay);
    response = await fetchImpl(
      new URL(
        `${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(job.jobId)}`,
        endpoint,
      ),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-starkscan-api-key": options.apiKey,
        },
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    payload = await responseObject(response, "Starkscan proof poll");
    if (!response.ok) return upstreamFailure(response, payload);
    job = parseJob(payload);
    if (options.stateStore) {
      const stored = await persistJob(
        options.stateStore,
        digest,
        attempt,
        job,
        request.id,
        now(),
      );
      if (stored) return stored;
    }
  }

  return terminalResponse(request.id, job);
}

/** Stable across Privacy SDK HTTP retries, whose JSON-RPC id may change. */
export async function starkscanIdempotencyKey(
  proveRequestBody: unknown,
  attempt = 0,
): Promise<string> {
  return starkscanIdempotencyKeyFromDigest(
    await starkscanRequestDigest(proveRequestBody),
    attempt,
  );
}

export async function starkscanRequestDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function starkscanIdempotencyKeyFromDigest(
  digest: string,
  attempt: number,
): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("Starkscan request digest is invalid");
  }
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error("Starkscan proof attempt is invalid");
  }
  return `privatepons-${digest}${attempt === 0 ? "" : `-r${attempt}`}`;
}

export function validateMainnetProveRequest(
  value: unknown,
  poolAddress = MAINNET_POOL_ADDRESS,
): MainnetProveRequest {
  const request = record(value, "proving JSON-RPC request");
  if (
    request.jsonrpc !== "2.0" ||
    request.method !== "starknet_proveTransaction" ||
    !(
      typeof request.id === "string" ||
      typeof request.id === "number" ||
      request.id === null
    )
  ) {
    throw new Error(
      "only one starknet_proveTransaction JSON-RPC request is allowed",
    );
  }
  const params = record(request.params, "starknet_proveTransaction params");
  if (
    Object.keys(params).some(
      (key) => key !== "block_id" && key !== "transaction",
    ) ||
    !("block_id" in params) ||
    !("transaction" in params)
  ) {
    throw new Error(
      "starknet_proveTransaction requires only block_id and transaction",
    );
  }
  explicitBlockId(params.block_id);
  const transaction = record(params.transaction, "proof transaction");
  if (transaction.type !== "INVOKE") {
    throw new Error("mainnet proving accepts only INVOKE proof transactions");
  }
  if (
    typeof transaction.sender_address !== "string" ||
    !sameFelt(transaction.sender_address, poolAddress)
  ) {
    throw new Error("proof transaction sender must be the STRK20 mainnet pool");
  }
  return {
    jsonrpc: "2.0",
    id: request.id as string | number | null,
    method: "starknet_proveTransaction",
    params: { block_id: params.block_id, transaction },
  };
}

async function loadStoredAttempt(
  store: StarkscanProverStateStore,
  digest: string,
  id: string | number | null,
  nowMs: number,
): Promise<{
  readonly attempt: number;
  readonly response?: StarkscanProverRelayResponse;
}> {
  const cursor = storedCursor(await store.get(cursorKey(digest)), nowMs);
  const terminal = storedTerminal(
    await store.get(terminalKey(digest, cursor.attempt)),
  );
  if (terminal) {
    if (
      terminal.status === "succeeded" &&
      terminal.result !== undefined &&
      !proofResultHasSubmissionMargin(terminal.result, nowMs)
    ) {
      const attempt = cursor.attempt + 1;
      await store.set(
        cursorKey(digest),
        newCursor(attempt, nowMs),
        CURSOR_TTL_SECONDS,
      );
      return { attempt };
    }
    return {
      attempt: cursor.attempt,
      response: terminalResponse(id, terminal),
    };
  }

  if (cursor.status === "succeeded") {
    // Starkscan delivered the result to an earlier process, but our short-lived
    // encrypted copy has expired or was evicted. A new logical attempt is now
    // required; never reuse the old idempotency key for a fresh proof.
    const attempt = cursor.attempt + 1;
    await store.set(
      cursorKey(digest),
      newCursor(attempt, nowMs),
      CURSOR_TTL_SECONDS,
    );
    return { attempt };
  }
  if (cursor.status === "unknown_delivery") {
    return {
      attempt: cursor.attempt,
      response: rpcFailure(
        id,
        -32000,
        `Starkscan delivery is unknown for ${cursor.jobId ?? "this proof job"}; do not resubmit automatically`,
      ),
    };
  }
  if (cursor.status === "failed") {
    return {
      attempt: cursor.attempt,
      response: rpcFailure(
        id,
        -32000,
        `Starkscan proof job ${cursor.jobId ?? "failed"} failed; rebuild the transaction before retrying`,
      ),
    };
  }
  return { attempt: cursor.attempt };
}

async function persistJob(
  store: StarkscanProverStateStore,
  digest: string,
  attempt: number,
  job: StarkscanJob,
  id: string | number | null,
  nowMs: number,
): Promise<StarkscanProverRelayResponse | undefined> {
  if (job.status === "succeeded" && job.result === undefined) {
    await store.set(
      cursorKey(digest),
      newCursor(attempt + 1, nowMs),
      CURSOR_TTL_SECONDS,
    );
    return {
      status: 503,
      body: {
        error:
          "Starkscan proof result was already delivered or expired; starting a new proof attempt",
        proofStatus: job.status,
      },
      retryAfter: "1",
    };
  }
  if (
    job.status === "succeeded" &&
    job.result !== undefined &&
    !proofResultHasSubmissionMargin(job.result, nowMs)
  ) {
    await store.set(
      cursorKey(digest),
      newCursor(attempt + 1, nowMs),
      CURSOR_TTL_SECONDS,
    );
    return {
      status: 503,
      body: {
        error:
          "Starkscan screening attestation is too close to expiry; starting a new proof attempt",
        proofStatus: job.status,
      },
      retryAfter: "1",
    };
  }

  if (job.terminal && job.status !== "unavailable") {
    // Persist the complete one-time payload before marking the durable cursor
    // terminal. If the cursor write is interrupted, the next process still
    // checks this attempt's terminal key first and can recover it.
    await store.set(
      terminalKey(digest, attempt),
      job,
      terminalTtlSeconds(job, nowMs),
    );
  }
  await store.set(
    cursorKey(digest),
    newCursor(attempt, nowMs, job),
    CURSOR_TTL_SECONDS,
  );
  return job.terminal ? terminalResponse(id, job) : undefined;
}

function storedCursor(value: unknown, nowMs: number): StoredCursor {
  if (value === undefined) return newCursor(0, nowMs);
  const cursor = record(value, "stored Starkscan proof cursor");
  if (
    cursor.version !== 1 ||
    typeof cursor.attempt !== "number" ||
    !Number.isSafeInteger(cursor.attempt) ||
    cursor.attempt < 0 ||
    typeof cursor.updatedAt !== "number" ||
    !Number.isSafeInteger(cursor.updatedAt) ||
    (cursor.jobId !== undefined &&
      (typeof cursor.jobId !== "string" ||
        !JOB_ID_PATTERN.test(cursor.jobId))) ||
    (cursor.status !== undefined && !isStatus(cursor.status))
  ) {
    throw new Error("stored Starkscan proof cursor is invalid");
  }
  return {
    version: 1,
    attempt: cursor.attempt,
    updatedAt: cursor.updatedAt,
    ...(typeof cursor.jobId === "string" ? { jobId: cursor.jobId } : {}),
    ...(isStatus(cursor.status) ? { status: cursor.status } : {}),
  };
}

function storedTerminal(value: unknown): StarkscanJob | undefined {
  return value === undefined ? undefined : parseJob(value);
}

function newCursor(
  attempt: number,
  nowMs: number,
  job?: StarkscanJob,
): StoredCursor {
  return {
    version: 1,
    attempt,
    updatedAt: Math.floor(nowMs),
    ...(job ? { jobId: job.jobId, status: job.status } : {}),
  };
}

function cursorKey(digest: string): string {
  return `proof:${digest}:cursor`;
}

function terminalKey(digest: string, attempt: number): string {
  return `proof:${digest}:terminal:${attempt}`;
}

function proofResultHasSubmissionMargin(
  result: unknown,
  nowMs: number,
): boolean {
  const issuedAt = screeningIssuedAt(result);
  if (issuedAt === undefined) return true;
  const age = Math.floor(nowMs / 1_000) - issuedAt;
  return (
    age >= -30 &&
    age <= SCREENING_MAX_AGE_SECONDS - SCREENING_SUBMISSION_MARGIN_SECONDS
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

function terminalTtlSeconds(job: StarkscanJob, nowMs: number): number {
  const issuedAt = screeningIssuedAt(job.result);
  if (issuedAt === undefined) return TERMINAL_TTL_SECONDS;
  return Math.max(
    1,
    Math.min(
      TERMINAL_TTL_SECONDS,
      issuedAt + SCREENING_MAX_AGE_SECONDS - Math.floor(nowMs / 1_000),
    ),
  );
}

function terminalResponse(
  id: string | number | null,
  job: StarkscanJob,
): StarkscanProverRelayResponse {
  if (job.status === "succeeded") {
    if (job.result === undefined) {
      return rpcFailure(
        id,
        -32000,
        `Starkscan proof result is unavailable (${job.resultUnavailableReason ?? "delivered_or_expired"})`,
      );
    }
    return {
      status: 200,
      body: { jsonrpc: "2.0", id, result: job.result },
    };
  }
  if (job.status === "unavailable") {
    return {
      status: 503,
      body: {
        error: "Starkscan prover is unavailable; retry the same request",
        jobId: job.jobId,
        proofStatus: job.status,
      },
    };
  }
  const error = errorObject(job.error);
  const message =
    job.status === "unknown_delivery"
      ? `Starkscan delivery is unknown for ${job.jobId}; do not resubmit automatically`
      : typeof error.message === "string"
        ? error.message
        : `Starkscan proof job ${job.jobId} failed`;
  return rpcFailure(
    id,
    typeof error.code === "number" ? error.code : -32000,
    message,
    error.data,
  );
}

function rpcFailure(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): StarkscanProverRelayResponse {
  return {
    status: 200,
    body: {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
  };
}

function upstreamFailure(
  response: Response,
  payload: Record<string, unknown>,
): StarkscanProverRelayResponse {
  return {
    status: response.status,
    body: payload,
    ...(response.headers.get("retry-after")
      ? { retryAfter: response.headers.get("retry-after")! }
      : {}),
  };
}

function parseJob(value: unknown): StarkscanJob {
  const job = record(value, "Starkscan proof job");
  if (
    typeof job.jobId !== "string" ||
    !JOB_ID_PATTERN.test(job.jobId) ||
    !isStatus(job.status) ||
    typeof job.terminal !== "boolean"
  ) {
    throw new Error("Starkscan returned an invalid proof job");
  }
  const terminal =
    job.status === "succeeded" ||
    job.status === "failed" ||
    job.status === "unavailable" ||
    job.status === "unknown_delivery";
  if (job.terminal !== terminal) {
    throw new Error("Starkscan returned an inconsistent proof job status");
  }
  return {
    jobId: job.jobId,
    status: job.status,
    terminal: job.terminal,
    ...(typeof job.pollAfterSeconds === "number"
      ? { pollAfterSeconds: job.pollAfterSeconds }
      : {}),
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(typeof job.resultUnavailableReason === "string"
      ? { resultUnavailableReason: job.resultUnavailableReason }
      : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
  };
}

async function responseObject(
  response: Response,
  field: string,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`${field} returned invalid JSON`);
  }
  return record(value, field);
}

function explicitBlockId(value: unknown): void {
  const block = record(value, "proof block_id");
  const keys = Object.keys(block);
  const validNumber =
    keys.length === 1 &&
    keys[0] === "block_number" &&
    typeof block.block_number === "number" &&
    Number.isSafeInteger(block.block_number) &&
    block.block_number >= 0;
  const validHash =
    keys.length === 1 &&
    keys[0] === "block_hash" &&
    typeof block.block_hash === "string" &&
    /^0x[0-9a-fA-F]{1,64}$/.test(block.block_hash);
  if (!validNumber && !validHash) {
    throw new Error(
      "mainnet proving requires an explicit block number or hash",
    );
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("proof request is not finite JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = record(value, "proof request");
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function proverEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("STARKSCAN_PROVER_URL must be a valid URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("STARKSCAN_PROVER_URL must be credential-free HTTPS");
  }
  return endpoint;
}

function sameFelt(left: string, right: string): boolean {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}

function errorObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function isStatus(value: unknown): value is StarkscanStatus {
  return (
    value === "queued" ||
    value === "dispatched" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "unavailable" ||
    value === "unknown_delivery"
  );
}
