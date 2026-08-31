const MAX_BODY_BYTES = 512 * 1024;

const SERVICES = Object.freeze({
  base: {
    environment: "BASE_SEPOLIA_RPC_URL",
    kind: "evm-rpc",
    methods: ["POST"],
  },
  robinhood: {
    environment: "ROBINHOOD_RPC_URL",
    kind: "evm-rpc",
    methods: ["POST"],
  },
  arbitrum: {
    environment: "ARBITRUM_RPC_URL",
    kind: "evm-rpc",
    methods: ["POST"],
  },
  "starknet-testnet": {
    environment: "STARKNET_SEPOLIA_RPC_URL",
    kind: "starknet-rpc",
    methods: ["POST"],
  },
  "starknet-mainnet": {
    environment: "STARKNET_MAINNET_RPC_URL",
    kind: "starknet-rpc",
    methods: ["POST"],
  },
  "prover-testnet": {
    environment: "STRK20_PROVER_URL",
    kind: "privacy-service",
    methods: ["GET", "POST"],
  },
  "indexer-testnet": {
    environment: "STRK20_INDEXER_URL",
    kind: "privacy-service",
    methods: ["GET", "POST"],
  },
  "prover-mainnet": {
    environment: "STRK20_MAINNET_PROVER_URL",
    kind: "privacy-service",
    methods: ["GET", "POST"],
  },
  "indexer-mainnet": {
    environment: "STRK20_MAINNET_INDEXER_URL",
    kind: "privacy-service",
    methods: ["GET", "POST"],
  },
  avnu: {
    environment: "AVNU_PAYMASTER_URL",
    headerEnvironment: "AVNU_PAYMASTER_API_KEY",
    header: "x-paymaster-api-key",
    kind: "avnu",
    methods: ["POST"],
  },
  relay: {
    environment: "RELAY_API_URL",
    headerEnvironment: "RELAY_API_KEY",
    header: "x-api-key",
    kind: "relay",
    methods: ["GET", "POST"],
  },
});

const EVM_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_sendRawTransaction",
  "net_version",
  "web3_clientVersion",
]);

const AVNU_METHODS = new Set([
  "paymaster_buildTransaction",
  "paymaster_executeTransaction",
  "paymaster_getSupportedTokens",
  "paymaster_isAvailable",
]);

export const config = { maxDuration: 60 };

export default async function handler(request, response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");

  try {
    const incoming = new URL(request.url || "/", "https://internal.invalid");
    const serviceName = incoming.searchParams.get("service") || "";
    const service = SERVICES[serviceName];
    if (!service) return json(response, 404, { error: "route not found" });

    const method = String(request.method || "GET").toUpperCase();
    if (!service.methods.includes(method)) {
      response.setHeader("allow", service.methods.join(", "));
      return json(response, 405, { error: "method not allowed" });
    }

    const body = await requestBody(request, method);
    validateRequest(service.kind, method, incoming, body);

    const upstreamValue = process.env[service.environment];
    if (!upstreamValue) {
      return json(response, 503, { error: "upstream is not configured" });
    }
    const upstream = upstreamUrl(upstreamValue, incoming);
    const headers = forwardHeaders(request.headers);
    if (service.headerEnvironment && service.header) {
      const credential = process.env[service.headerEnvironment];
      if (!credential) {
        return json(response, 503, {
          error: "upstream credential is not configured",
        });
      }
      headers.set(service.header, credential);
    }

    const result = await fetch(upstream, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(55_000),
    });

    response.statusCode = result.status;
    const contentType = result.headers.get("content-type");
    if (contentType) response.setHeader("content-type", contentType);
    const retryAfter = result.headers.get("retry-after");
    if (retryAfter) response.setHeader("retry-after", retryAfter);
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "proxy request failed";
    const status = /too large|invalid|not allowed|unsupported/.test(message)
      ? 400
      : 502;
    json(response, status, { error: message });
  }
}

function upstreamUrl(value, incoming) {
  const target = new URL(value);
  if (target.protocol !== "https:") throw new Error("upstream must use HTTPS");

  const forwardedPath = incoming.searchParams.get("path") || "";
  if (forwardedPath.includes("..") || forwardedPath.includes("\\")) {
    throw new Error("invalid upstream path");
  }
  if (forwardedPath) {
    target.pathname = `${target.pathname.replace(/\/$/, "")}/${forwardedPath.replace(/^\/+/, "")}`;
  }
  for (const [name, value] of incoming.searchParams) {
    if (name !== "service" && name !== "path")
      target.searchParams.append(name, value);
  }
  return target;
}

function validateRequest(kind, method, incoming, body) {
  const path = `/${(incoming.searchParams.get("path") || "").replace(/^\/+/, "")}`;
  if (kind === "relay") {
    const allowed =
      (method === "POST" && path === "/quote/v2") ||
      (method === "GET" && path === "/intents/status/v3");
    if (!allowed) throw new Error("Relay path is not allowed");
  }
  if (kind === "privacy-service" && !path.startsWith("/v1/")) {
    throw new Error("privacy-service path is not allowed");
  }
  if (kind === "evm-rpc")
    validateJsonRpc(body, (name) => EVM_METHODS.has(name));
  if (kind === "starknet-rpc")
    validateJsonRpc(body, (name) => name.startsWith("starknet_"));
  if (kind === "avnu") validateJsonRpc(body, (name) => AVNU_METHODS.has(name));
}

function validateJsonRpc(body, allows) {
  let payload;
  try {
    payload = JSON.parse(body?.toString("utf8") || "");
  } catch {
    throw new Error("invalid JSON-RPC body");
  }
  const requests = Array.isArray(payload) ? payload : [payload];
  if (!requests.length || requests.length > 20) {
    throw new Error("invalid JSON-RPC batch");
  }
  for (const entry of requests) {
    if (!entry || typeof entry !== "object" || !allows(entry.method)) {
      throw new Error("JSON-RPC method is not allowed");
    }
  }
}

async function requestBody(request, method) {
  if (method === "GET" || method === "HEAD") return undefined;
  if (request.body !== undefined && request.body !== null) {
    const body = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(
          typeof request.body === "string"
            ? request.body
            : JSON.stringify(request.body),
        );
    if (body.length > MAX_BODY_BYTES) throw new Error("request body too large");
    return body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function forwardHeaders(source) {
  const headers = new Headers();
  for (const name of ["accept", "content-type"]) {
    const value = source[name];
    if (typeof value === "string") headers.set(name, value);
  }
  headers.set("accept-encoding", "identity");
  return headers;
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
