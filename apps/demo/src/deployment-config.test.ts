import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Rewrite {
  source: string;
  destination: string;
}

interface VercelConfig {
  rewrites: Rewrite[];
}

const configPath = resolve(process.cwd(), "public/vercel.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as VercelConfig;

describe("production privacy-service rewrites", () => {
  it.each([
    ["/rpc", "starknet-mainnet"],
    ["/prover", "prover-mainnet"],
    ["/indexer", "indexer-mainnet"],
  ])("routes %s and its nested paths to %s", (basePath, service) => {
    expect(config.rewrites).toContainEqual({
      source: basePath,
      destination: `/api/proxy?service=${service}`,
    });
    expect(config.rewrites).toContainEqual({
      source: `${basePath}/:path*`,
      destination: `/api/proxy?service=${service}&path=:path*`,
    });
  });

  it.each(["/rpc", "/prover", "/indexer"])(
    "keeps explicit network routes ahead of the generic %s route",
    (basePath) => {
      const genericIndex = config.rewrites.findIndex(
        ({ source }) => source === `${basePath}/:path*`,
      );

      expect(genericIndex).toBeGreaterThan(
        config.rewrites.findIndex(
          ({ source }) => source === `${basePath}/mainnet/:path*`,
        ),
      );
      expect(genericIndex).toBeGreaterThan(
        config.rewrites.findIndex(
          ({ source }) => source === `${basePath}/testnet/:path*`,
        ),
      );
    },
  );
});
