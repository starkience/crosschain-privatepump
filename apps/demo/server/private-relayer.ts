import { randomUUID } from "node:crypto";
import {
  parseRelayRequest,
  relayerFromEnv,
  type PrivateLaunchpadRelayer,
} from "../../../packages/relayer/src/index.js";

const MAX_BODY_BYTES = 128 * 1024;
let cachedRelayer: PrivateLaunchpadRelayer | undefined;

export const config = { maxDuration: 60 };

export default async function handler(
  request: {
    method?: string;
    url?: string;
    body?: unknown;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  },
  response: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(value?: string): void;
  },
): Promise<void> {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");

  try {
    const url = new URL(request.url ?? "/", "https://internal.invalid");
    const path = `/${(url.searchParams.get("path") ?? "").replace(/^\/+/, "")}`;
    const relayer = getRelayer();

    if (request.method === "GET" && path === "/healthz") {
      const relayerAddress = relayer.dependencies.relayerAccount.address;
      const gasBalance = await relayer.dependencies.publicClient.getBalance({
        address: relayerAddress,
      });
      return json(response, 200, {
        ok: true,
        readyForBroadcast: gasBalance > 0n,
        relayerAddress,
        gasBalanceWei: gasBalance.toString(),
      });
    }

    if (request.method !== "POST" || path !== "/v1/relay") {
      return json(response, 404, { error: "not found" });
    }

    const requestId = randomUUID();
    try {
      const relayRequest = parseRelayRequest(await readJson(request));
      console.info(
        JSON.stringify({
          event: "relay.received",
          requestId,
          callCount: relayRequest.calls.length,
        }),
      );
      const transactionHash = await relayer.relay(relayRequest);
      console.info(
        JSON.stringify({
          event: "relay.broadcast",
          requestId,
          transactionHash,
        }),
      );
      return json(response, 202, { transactionHash, requestId });
    } catch (error) {
      const message = boundedErrorMessage(error);
      console.error(
        JSON.stringify({
          event: "relay.rejected",
          requestId,
          broadcasted: false,
          error: message,
        }),
      );
      return json(response, 400, {
        error: message,
        requestId,
        broadcasted: false,
      });
    }
  } catch (error) {
    const message = boundedErrorMessage(error, "relayer failed");
    json(response, 503, { error: message });
  }
}

export function boundedErrorMessage(
  error: unknown,
  fallback = "unknown error",
): string {
  const raw = error instanceof Error ? error.message : fallback;
  const reasonOnly = raw.split(
    /\n\s*(?:Contract Call|Request Arguments|Raw Call Arguments):/i,
  )[0]!;
  const compact = reasonOnly.replace(/\s+/g, " ").trim() || fallback;
  const redacted = compact.replace(/0x[0-9a-fA-F]{128,}/g, "[redacted hex]");
  return redacted.length > 800 ? `${redacted.slice(0, 797)}…` : redacted;
}

function getRelayer(): PrivateLaunchpadRelayer {
  cachedRelayer ??= relayerFromEnv(process.env);
  return cachedRelayer;
}

async function readJson(request: {
  body?: unknown;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}): Promise<unknown> {
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
      return request.body;
    }
    const value = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(String(request.body));
    if (value.length > MAX_BODY_BYTES)
      throw new Error("request body too large");
    return parseJson(value);
  }

  if (!request[Symbol.asyncIterator])
    throw new Error("request body is missing");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<unknown>) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += value.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(value);
  }
  return parseJson(Buffer.concat(chunks));
}

function parseJson(value: Buffer): unknown {
  try {
    return JSON.parse(value.toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid JSON");
  }
}

function json(
  response: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(value?: string): void;
  },
  status: number,
  body: Record<string, unknown>,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
