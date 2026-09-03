import { Buffer } from "node:buffer";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "./proxy.js";
import { verifyRelayQuoteAttestation } from "../../../packages/relayer/src/relay-quote-attestation.js";

const POOL =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const DEPOSIT = "0x4444444444444444444444444444444444444444";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ATTESTATION_KEY = "11".repeat(32);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("production edge proxy", () => {
  it("routes the SDK prover root and fails safely when durable state is not configured", async () => {
    vi.stubEnv("PROVER_PROVIDER", "starkscan");
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

  it("routes mainnet proofs to StarkWare when it is the selected provider", async () => {
    vi.stubEnv("PROVER_PROVIDER", "starkware");
    vi.stubEnv(
      "STRK20_MAINNET_PROVER_URL",
      "https://transaction-prover.alpha-mainnet.sw-dev.io/",
    );
    vi.stubEnv("PROVER_STATE_REST_URL", "https://redis.example");
    vi.stubEnv("PROVER_STATE_REST_TOKEN", "redis-secret");
    vi.stubEnv("PROVER_STATE_ENCRYPTION_KEY", "00".repeat(32));
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === "https://redis.example/") {
          const command = JSON.parse(String(init?.body)) as string[];
          return Response.json({ result: command[0] === "GET" ? null : "OK" });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: 2,
          result: {
            proof: "proof-data",
            proof_facts: ["0xfact"],
            l2_to_l1_messages: [],
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchImpl);
    const response = fakeResponse();

    await handler(
      {
        url: "/api/proxy?service=prover-mainnet",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: {
          jsonrpc: "2.0",
          id: 2,
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

    expect(response.status()).toBe(200);
    expect(response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { proof: "proof-data" },
    });
    expect(response.header("x-privatepons-prover")).toBe("starkware");
    expect(
      fetchImpl.mock.calls.some(
        ([input]) =>
          String(input) ===
          "https://transaction-prover.alpha-mainnet.sw-dev.io/",
      ),
    ).toBe(true);
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

  it("seals an exact Robinhood return quote for policy verification", async () => {
    vi.stubEnv("RELAY_API_URL", "https://api.relay.link");
    vi.stubEnv("RELAY_API_KEY", "server-secret");
    vi.stubEnv("RELAY_QUOTE_ATTESTATION_KEY", ATTESTATION_KEY);
    const amount = "1764547";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          requestId: `0x${"ab".repeat(32)}`,
          details: {
            currencyIn: {
              currency: { chainId: 4663, address: USDG },
              amount,
            },
            currencyOut: {
              currency: { chainId: 42161, address: USDC },
              amount: "1160000",
              minimumAmount: "1150000",
            },
          },
          steps: [
            {
              id: "deposit",
              items: [
                {
                  data: {
                    chainId: 4663,
                    from: ACCOUNT,
                    to: USDG,
                    value: "0",
                    data: `0xa9059cbb${DEPOSIT.slice(2).padStart(64, "0")}${BigInt(amount).toString(16).padStart(64, "0")}`,
                  },
                },
              ],
            },
          ],
        }),
      ),
    );
    const response = fakeResponse();

    await handler(
      {
        url: "/api/proxy?service=relay&path=quote/v2",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: {
          user: ACCOUNT,
          originChainId: 4663,
          destinationChainId: 42161,
          originCurrency: USDG,
          destinationCurrency: USDC,
          amount,
          recipient: RECIPIENT,
          refundTo: OWNER,
          tradeType: "EXACT_INPUT",
          useDepositAddress: true,
          strict: true,
        },
      } as never,
      response.value,
    );

    expect(response.status()).toBe(200);
    const quote = response.json() as Record<string, unknown>;
    const attestation = String(quote.privatePonsAttestation);
    expect(attestation).toMatch(/^v1\./);
    expect(
      verifyRelayQuoteAttestation(ATTESTATION_KEY, attestation),
    ).toMatchObject({
      requestId: `0x${"ab".repeat(32)}`,
      account: ACCOUNT,
      owner: OWNER,
      recipient: RECIPIENT,
      depositAddress: DEPOSIT,
      amount,
    });
  });

  it("retries a rate-limited read-only Robinhood RPC request", async () => {
    vi.stubEnv("ROBINHOOD_RPC_URL", "https://rpc.mainnet.chain.robinhood.com");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { jsonrpc: "2.0", id: 1, error: { code: 429, message: "busy" } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ jsonrpc: "2.0", id: 1, result: "0x2a" }),
      );
    vi.stubGlobal("fetch", fetchImpl);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const response = fakeResponse();

    await handler(
      {
        url: "/api/proxy?service=robinhood",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [
            { to: "0x1111111111111111111111111111111111111111" },
            "latest",
          ],
        },
      } as never,
      response.value,
    );

    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: "0x2a" });
    expect(response.header("x-privatepons-upstream-retries")).toBe("1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries an empty read-only RPC response instead of forwarding invalid JSON", async () => {
    vi.stubEnv("ARBITRUM_RPC_URL", "https://arb1.example");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({ jsonrpc: "2.0", id: 1, result: "0xa4b1" }),
      );
    vi.stubGlobal("fetch", fetchImpl);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const response = fakeResponse();

    await handler(
      {
        url: "/api/proxy?service=arbitrum",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        },
      } as never,
      response.value,
    );

    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: "0xa4b1",
    });
    expect(response.header("x-privatepons-upstream-retries")).toBe("1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

function fakeResponse(): {
  readonly value: ServerResponse;
  readonly status: () => number;
  readonly json: () => unknown;
  readonly header: (name: string) => string | undefined;
} {
  const state: {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  } = {
    statusCode: 200,
    body: "",
    headers: {},
  };
  const value = {
    setHeader: vi.fn(
      (name: string, value: string | number | readonly string[]) => {
        state.headers[name.toLowerCase()] = String(value);
      },
    ),
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
    header: (name) => state.headers[name.toLowerCase()],
  };
}
