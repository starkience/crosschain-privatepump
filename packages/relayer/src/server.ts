import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import type { PrivateLaunchpadRelayer } from "./relayer.js";
import { parseRelayRequest } from "./schema.js";
import { tradeQuoteJson, type ClankerQuoteProvider } from "./clanker-quotes.js";

const MAX_BODY_BYTES = 128 * 1024;

export function startRelayerServer(
  relayer: PrivateLaunchpadRelayer,
  port: number,
  options: { quoteService?: ClankerQuoteProvider } = {},
) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        const relayerAddress = relayer.dependencies.relayerAccount.address;
        const gasBalance = await relayer.dependencies.publicClient.getBalance({
          address: relayerAddress,
        });
        return json(response, 200, {
          ok: true,
          clankerQuotes: !!options.quoteService,
          readyForBroadcast: gasBalance > 0n,
          relayerAddress,
          gasBalanceWei: gasBalance.toString(),
        });
      }
      if (request.method === "POST" && request.url === "/v1/clanker/quote") {
        if (!options.quoteService) {
          return json(response, 503, {
            error: "Clanker trade quotes are not configured",
          });
        }
        const body = await readJson(request);
        const quote = await options.quoteService.quote(body);
        return json(response, 200, tradeQuoteJson(quote));
      }
      if (request.method !== "POST" || request.url !== "/v1/relay") {
        return json(response, 404, { error: "not found" });
      }
      const requestId = randomUUID();
      try {
        const body = await readJson(request);
        const relayRequest = parseRelayRequest(body);
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
        const message =
          error instanceof Error ? error.message : "unknown error";
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
      const message = error instanceof Error ? error.message : "unknown error";
      return json(response, 400, { error: message });
    }
  });
  return server.listen(port);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid JSON");
  }
}

function json(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}
