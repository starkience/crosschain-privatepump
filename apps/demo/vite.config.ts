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
    "/rpc/testnet",
    environment.STARKNET_SEPOLIA_RPC_URL,
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
    "/api/avnu",
    environment.AVNU_PAYMASTER_API_KEY
      ? environment.AVNU_PAYMASTER_URL
      : undefined,
    "AVNU_PAYMASTER_URL and AVNU_PAYMASTER_API_KEY",
    environment.AVNU_PAYMASTER_API_KEY,
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

function addProxy(
  proxy: Record<string, ProxyOptions>,
  path: string,
  target: string | undefined,
  environmentName: string,
  paymasterApiKey?: string,
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
    ...(paymasterApiKey
      ? {
          configure: (server) => {
            server.on("proxyReq", (request) => {
              request.setHeader("x-paymaster-api-key", paymasterApiKey);
            });
          },
        }
      : {}),
  };
}
