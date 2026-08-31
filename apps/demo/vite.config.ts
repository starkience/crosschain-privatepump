import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { loadEnv, type ProxyOptions } from "vite";

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
  addProxy(
    proxy,
    "/prover/mainnet",
    environment.STRK20_MAINNET_PROVER_URL,
    "STRK20_MAINNET_PROVER_URL",
  );
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
    plugins: [react()],
    server: { port: 4173, proxy },
    preview: { port: 4173 },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
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
