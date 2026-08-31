import { Buffer } from "node:buffer";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "./proxy.js";

const POOL =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("production edge proxy", () => {
  it("routes the SDK prover root and fails safely when durable state is not configured", async () => {
    vi.stubEnv(
      "STARKSCAN_PROVER_URL",
      "https://api.starkscan.co/v1/SN_MAIN/prove",
    );
    vi.stubEnv("STARKSCAN_API_KEY", "server-secret");
    vi.stubEnv("PROVER_STATE_REST_URL", "");
    vi.stubEnv("PROVER_STATE_REST_TOKEN", "");
    vi.stubEnv("PROVER_STATE_ENCRYPTION_KEY", "");
    const response = fakeResponse();

    await handler(
      {
        url: "/api/proxy?service=prover-mainnet",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "starknet_proveTransaction",
          params: {
            block_id: { block_number: 14_000_000 },
            transaction: {
              type: "INVOKE",
              sender_address: POOL,
              calldata: ["0x1"],
            },
          },
        },
      } as never,
      response.value,
    );

    expect(response.status()).toBe(503);
    expect(response.json()).toEqual({
      error: "PROVER_STATE_REST_URL is required",
    });
    expect(response.json()).not.toEqual({
      error: "privacy-service path is not allowed",
    });
  });

  it("rejects disallowed Relay paths before contacting the upstream", async () => {
    vi.stubEnv("RELAY_API_URL", "https://api.relay.link");
    vi.stubEnv("RELAY_API_KEY", "server-secret");
    const response = fakeResponse();

    await handler(
      {
        url: "/api/proxy?service=relay&path=admin",
        method: "GET",
        headers: {},
      } as never,
      response.value,
    );

    expect(response.status()).toBe(400);
    expect(response.json()).toEqual({ error: "Relay path is not allowed" });
  });
});

function fakeResponse(): {
  readonly value: ServerResponse;
  readonly status: () => number;
  readonly json: () => unknown;
} {
  const state: { statusCode: number; body: string } = {
    statusCode: 200,
    body: "",
  };
  const value = {
    setHeader: vi.fn(),
    end: vi.fn((body?: string | Buffer) => {
      state.body = body?.toString() ?? "";
    }),
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(value: number) {
      state.statusCode = value;
    },
  } as unknown as ServerResponse;
  return {
    value,
    status: () => state.statusCode,
    json: () => JSON.parse(state.body) as unknown,
  };
}
