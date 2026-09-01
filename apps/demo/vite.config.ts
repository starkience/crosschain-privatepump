import { defineConfig } from "vitest/config";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin, type ProxyOptions } from "vite";
import { relayStarkscanProverRequest } from "./src/starkscan-prover-relay.js";
import { createMemoryStarkscanProverStateStore } from "./src/starkscan-prover-store.js";
import { relayStarkwareProverRequest } from "./src/starkware-prover-relay.js";

const environmentDirectory = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, environmentDirectory, "");
  const proxy: Record<string, ProxyOptions> = {};

  addProxy(
    proxy,
    "/base-rpc",
    environment.BASE_SEPOLIA_RPC_URL,
    "BASE_SEPOLIA_RPC_URL",
  );
  addProxy(
    proxy,
    "/robinhood-rpc",
    environment.ROBINHOOD_RPC_URL,
    "ROBINHOOD_RPC_URL",
  );
  addProxy(
    proxy,
    "/arbitrum-rpc",
    environment.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
    "ARBITRUM_RPC_URL",
  );
  addProxy(
    proxy,
    "/rpc/testnet",
    bridgeCompatibleStarknetRpcUrl(environment.STARKNET_SEPOLIA_RPC_URL),
    "STARKNET_SEPOLIA_RPC_URL",
  );
  addProxy(
    proxy,
    "/prover/testnet",
    environment.STRK20_PROVER_URL,
    "STRK20_PROVER_URL",
  );
  addProxy(
    proxy,
    "/indexer/testnet",
    environment.STRK20_INDEXER_URL,
    "STRK20_INDEXER_URL",
  );
  addProxy(
    proxy,
    "/rpc/mainnet",
    bridgeCompatibleStarknetRpcUrl(environment.STARKNET_MAINNET_RPC_URL),
    "STARKNET_MAINNET_RPC_URL",
  );
  const proverProvider = mainnetProverProvider(environment.PROVER_PROVIDER);
  const mainnetProver =
    proverProvider === "starkware" && environment.STRK20_MAINNET_PROVER_URL
      ? createStarkwareProverPlugin(environment.STRK20_MAINNET_PROVER_URL)
      : proverProvider === "starkscan" &&
          environment.STARKSCAN_API_KEY &&
          environment.STARKSCAN_PROVER_URL
        ? createStarkscanProverPlugin(
            environment.STARKSCAN_PROVER_URL,
            environment.STARKSCAN_API_KEY,
          )
        : undefined;
  if (!mainnetProver) {
    addProxy(
      proxy,
      "/prover/mainnet",
      undefined,
      proverProvider === "starkware"
        ? "STRK20_MAINNET_PROVER_URL"
        : "STARKSCAN_PROVER_URL and STARKSCAN_API_KEY",
    );
  }
  addProxy(
    proxy,
    "/indexer/mainnet",
    environment.STRK20_MAINNET_INDEXER_URL,
    "STRK20_MAINNET_INDEXER_URL",
  );
  addProxy(
    proxy,
    "/api/avnu",
    environment.AVNU_PAYMASTER_API_KEY
      ? environment.AVNU_PAYMASTER_URL
      : undefined,
    "AVNU_PAYMASTER_URL and AVNU_PAYMASTER_API_KEY",
    environment.AVNU_PAYMASTER_API_KEY
      ? { "x-paymaster-api-key": environment.AVNU_PAYMASTER_API_KEY }
      : undefined,
  );
  addProxy(
    proxy,
    "/api/relay",
    environment.RELAY_API_KEY
      ? environment.RELAY_API_URL || "https://api.relay.link"
      : undefined,
    "RELAY_API_KEY",
    environment.RELAY_API_KEY
      ? { "x-api-key": environment.RELAY_API_KEY }
      : undefined,
  );
  addProxy(
    proxy,
    "/api/private-launchpad",
    environment.PRIVATE_LAUNCHPAD_RELAYER_ORIGIN,
    "PRIVATE_LAUNCHPAD_RELAYER_ORIGIN",
  );

  return {
    envDir: environmentDirectory,
    plugins: [react(), ...(mainnetProver ? [mainnetProver] : [])],
    server: { port: 4173, proxy },
    preview: { port: 4173 },
    test: {
      environment: "jsdom",
      include: ["{src,server}/**/*.test.{ts,tsx}"],
    },
  };
});

function bridgeCompatibleStarknetRpcUrl(
  target: string | undefined,
): string | undefined {
  if (!target) return target;

  // The pinned STRK20 bridge reads speculative state through the v0.10
  // `pre_confirmed` block tag. Alchemy's older versioned endpoints reject it.
  return target.replace(
    /\/starknet\/version\/rpc\/v0_(?:7|8|9)\//,
    "/starknet/version/rpc/v0_10/",
  );
}

function createStarkscanProverPlugin(endpoint: string, apiKey: string): Plugin {
  const stateStore = createMemoryStarkscanProverStateStore();
  return createMainnetProverPlugin("starkscan", (value) =>
    relayStarkscanProverRequest(value, { endpoint, apiKey, stateStore }),
  );
}

function createStarkwareProverPlugin(endpoint: string): Plugin {
  const stateStore = createMemoryStarkscanProverStateStore();
  return createMainnetProverPlugin("starkware", (value) =>
    relayStarkwareProverRequest(value, { endpoint, stateStore }),
  );
}

function createMainnetProverPlugin(
  provider: "starkware" | "starkscan",
  relay: (value: unknown) => Promise<{
    readonly status: number;
    readonly body: Record<string, unknown>;
    readonly retryAfter?: string;
  }>,
): Plugin {
  const install = (middlewares: {
    use(
      handler: (
        request: import("node:http").IncomingMessage,
        response: import("node:http").ServerResponse,
        next: () => void,
      ) => void,
    ): void;
  }) => {
    middlewares.use(async (request, response, next) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname !== "/prover/mainnet") return next();
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      if (request.method !== "POST") {
        response.statusCode = 405;
        response.setHeader("allow", "POST");
        response.end(JSON.stringify({ error: "method not allowed" }));
        return;
      }
      try {
        const result = await relay(await readJsonBody(request));
        response.statusCode = result.status;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("x-privatepons-prover", provider);
        if (result.retryAfter) {
          response.setHeader("retry-after", result.retryAfter);
        }
        response.end(JSON.stringify(result.body));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "prover proxy failed";
        response.statusCode = /proof state|PROVER_STATE_/i.test(message)
          ? 503
          : /too large|invalid|required|not allowed|must|only|explicit|sender|unsupported/i.test(
                message,
              )
            ? 400
            : 502;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ error: message }));
      }
    });
  };
  return {
    name: `privatepons-${provider}-prover`,
    configureServer: (server) => install(server.middlewares),
    configurePreviewServer: (server) => install(server.middlewares),
  };
}

function mainnetProverProvider(
  value: string | undefined,
): "starkware" | "starkscan" {
  const provider = value?.trim().toLowerCase() || "starkware";
  if (provider !== "starkware" && provider !== "starkscan") {
    throw new Error("PROVER_PROVIDER must be starkware or starkscan");
  }
  return provider;
}

async function readJsonBody(
  request: import("node:http").IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 1024 * 1024) throw new Error("prover request is too large");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid prover JSON request");
  }
}

function addProxy(
  proxy: Record<string, ProxyOptions>,
  path: string,
  target: string | undefined,
  environmentName: string,
  requestHeaders?: Readonly<Record<string, string>>,
): void {
  const prefix = new RegExp(`^${path}`);
  if (!target) {
    proxy[path] = {
      target: "http://127.0.0.1:0",
      bypass: (_request, response) => {
        if (!response) return path;
        response.statusCode = 502;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: `${environmentName} is not configured in this dev server`,
          }),
        );
        return path;
      },
    };
    return;
  }

  proxy[path] = {
    target,
    changeOrigin: true,
    secure: target.startsWith("https://"),
    rewrite: (requestPath) => requestPath.replace(prefix, ""),
    ...(requestHeaders
      ? {
          configure: (server) => {
            server.on("proxyReq", (request) => {
              for (const [name, value] of Object.entries(requestHeaders)) {
                request.setHeader(name, value);
              }
            });
          },
        }
      : {}),
  };
}
