import { randomUUID } from "node:crypto";
import { decodeErrorResult, isHex, type Hex } from "viem";
import {
  parseRelayRequest,
  readRelayerGasReadiness,
  relayerFromEnv,
  type PrivateLaunchpadRelayer,
} from "../../../packages/relayer/src/index.js";
import { privateLaunchpadAccountFactoryAbi } from "../../../packages/sdk/src/index.js";

const MAX_BODY_BYTES = 128 * 1024;
let cachedRelayer: PrivateLaunchpadRelayer | undefined;

export const config = { maxDuration: 60 };

const executionTargetErrorAbi = [
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [
      { name: "spender", type: "address" },
      { name: "allowance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "SlippageExceeded",
    inputs: [
      { name: "actual", type: "uint256" },
      { name: "minimum", type: "uint256" },
    ],
  },
  { type: "error", name: "CurveGraduated", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "MinimumOutputRequired", inputs: [] },
] as const;

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
      const gas = await readRelayerGasReadiness(
        relayer.dependencies.publicClient,
        relayerAddress,
      );
      return json(response, 200, {
        ok: true,
        readyForBroadcast: gas.readyForBroadcast,
        relayerAddress,
        gasBalanceWei: gas.gasBalance.toString(),
        gasPriceWei: gas.gasPrice.toString(),
        minimumGasBalanceWei: gas.minimumGasBalance.toString(),
        minimumGasUnits: gas.minimumGasUnits.toString(),
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
  const raw =
    decodedExecutionRevert(error) ??
    (error instanceof Error ? error.message : fallback);
  const reasonOnly = raw.split(
    /\n\s*(?:Contract Call|Request Arguments|Raw Call Arguments):/i,
  )[0]!;
  const compact = reasonOnly.replace(/\s+/g, " ").trim() || fallback;
  const redacted = compact.replace(/0x[0-9a-fA-F]{128,}/g, "[redacted hex]");
  return redacted.length > 800 ? `${redacted.slice(0, 797)}…` : redacted;
}

function decodedExecutionRevert(error: unknown): string | undefined {
  const raw = rawRevertData(error);
  if (!raw || raw === "0x") return undefined;
  try {
    const decoded = decodeErrorResult({
      abi: privateLaunchpadAccountFactoryAbi,
      data: raw,
    });
    if (decoded.errorName !== "CallFailed") {
      return `The contract function "deployAndExecute" reverted: ${decoded.errorName}()`;
    }
    const [index, reason] = decoded.args;
    return `The contract function "deployAndExecute" reverted: execution call ${Number(index) + 1} failed${decodedTargetReason(reason)}`;
  } catch {
    return undefined;
  }
}

function decodedTargetReason(reason: Hex): string {
  if (reason === "0x") return " without a reason";
  try {
    const decoded = decodeErrorResult({
      abi: executionTargetErrorAbi,
      data: reason,
    });
    if (decoded.errorName === "ERC20InsufficientBalance") {
      const [, balance, needed] = decoded.args;
      return `: ERC20InsufficientBalance(available ${balance}, required ${needed})`;
    }
    if (decoded.errorName === "ERC20InsufficientAllowance") {
      const [, allowance, needed] = decoded.args;
      return `: ERC20InsufficientAllowance(available ${allowance}, required ${needed})`;
    }
    if (decoded.errorName === "SlippageExceeded") {
      const [actual, minimum] = decoded.args;
      return `: SlippageExceeded(actual ${actual}, minimum ${minimum})`;
    }
    return `: ${decoded.errorName}()`;
  } catch {
    return ` with selector ${reason.slice(0, 10)}`;
  }
}

function rawRevertData(error: unknown): Hex | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const candidate = current as {
      raw?: unknown;
      data?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.raw === "string" && isHex(candidate.raw)) {
      return candidate.raw;
    }
    if (typeof candidate.data === "string" && isHex(candidate.data)) {
      return candidate.data;
    }
    current = candidate.cause;
  }
  return undefined;
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
