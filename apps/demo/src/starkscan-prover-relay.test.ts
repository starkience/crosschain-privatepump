import { describe, expect, it, vi } from "vitest";
import {
  relayStarkscanProverRequest,
  starkscanIdempotencyKey,
} from "./starkscan-prover-relay.js";
import { createMemoryStarkscanProverStateStore } from "./starkscan-prover-store.js";

const POOL =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const ENDPOINT = "https://api.starkscan.co/v1/SN_MAIN/prove";
const JOB_ID = `prv_${"a".repeat(24)}`;

function request(id: number, calldata = ["0x1"]) {
  return {
    jsonrpc: "2.0",
    id,
    method: "starknet_proveTransaction",
    params: {
      block_id: { block_number: 14_000_000 },
      transaction: {
        type: "INVOKE",
        sender_address: POOL,
        calldata,
      },
    },
  };
}

describe("Starkscan prover relay adapter", () => {
  it("adapts a synchronous SDK call to an async job without exposing the key", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            jobId: JOB_ID,
            status: "queued",
            terminal: false,
            pollAfterSeconds: 1,
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          jobId: JOB_ID,
          status: "succeeded",
          terminal: true,
          result: {
            proof: "proof-data",
            proof_facts: ["0xfact"],
            l2_to_l1_messages: [],
            additional_data: {
              signature: {
                issued_at: 1_788_000_000,
                sig_r: "0x1",
                sig_s: "0x2",
              },
            },
          },
        }),
      );

    const result = await relayStarkscanProverRequest(request(7), {
      endpoint: ENDPOINT,
      apiKey: "server-secret",
      fetchImpl,
      sleep: async () => undefined,
    });

    expect(result).toEqual({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 7,
        result: expect.objectContaining({
          proof: "proof-data",
          additional_data: expect.objectContaining({
            signature: expect.any(Object),
          }),
        }),
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [submissionUrl, submissionInit] = fetchImpl.mock.calls[0]!;
    expect(String(submissionUrl)).toBe(ENDPOINT);
    const headers = new Headers(submissionInit.headers);
    expect(headers.get("x-starkscan-api-key")).toBe("server-secret");
    expect(headers.get("idempotency-key")).toMatch(
      /^privatepons-[0-9a-f]{64}$/,
    );
    expect(JSON.parse(String(submissionInit.body))).toEqual(request(7).params);
    expect(JSON.stringify(result)).not.toContain("server-secret");
  });

  it("derives the same idempotency key when only object order changes", async () => {
    await expect(
      Promise.all([
        starkscanIdempotencyKey({
          block_id: { block_number: 12 },
          transaction: { type: "INVOKE", calldata: ["0x1"] },
        }),
        starkscanIdempotencyKey({
          transaction: { calldata: ["0x1"], type: "INVOKE" },
          block_id: { block_number: 12 },
        }),
      ]),
    ).resolves.toEqual([
      expect.stringMatching(/^privatepons-[0-9a-f]{64}$/),
      expect.stringMatching(/^privatepons-[0-9a-f]{64}$/),
    ]);
    const first = await starkscanIdempotencyKey({ a: 1, b: 2 });
    const reordered = await starkscanIdempotencyKey({ b: 2, a: 1 });
    expect(first).toBe(reordered);
  });

  it("returns a retryable response before the Privacy SDK request times out", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json(
        {
          jobId: JOB_ID,
          status: "dispatched",
          terminal: false,
          pollAfterSeconds: 10,
        },
        { status: 202 },
      ),
    );

    await expect(
      relayStarkscanProverRequest(request(8), {
        endpoint: ENDPOINT,
        apiKey: "server-secret",
        fetchImpl,
        maxWaitMs: 5_000,
        now: () => 0,
      }),
    ).resolves.toEqual({
      status: 503,
      body: {
        error: "Starkscan proof is still in progress",
        jobId: JOB_ID,
        proofStatus: "dispatched",
      },
      retryAfter: "10",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("passes terminal prover errors back as JSON-RPC errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        jobId: JOB_ID,
        status: "failed",
        terminal: true,
        error: { code: 55, message: "Account validation failed" },
      }),
    );

    await expect(
      relayStarkscanProverRequest(request(9), {
        endpoint: ENDPOINT,
        apiKey: "server-secret",
        fetchImpl,
      }),
    ).resolves.toEqual({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 9,
        error: { code: 55, message: "Account validation failed" },
      },
    });
  });

  it("rejects requests that are not pinned to the mainnet pool", async () => {
    const malformed = request(10);
    malformed.params.transaction.sender_address = "0x123";
    await expect(
      relayStarkscanProverRequest(malformed, {
        endpoint: ENDPOINT,
        apiKey: "server-secret",
      }),
    ).rejects.toThrow("STRK20 mainnet pool");
  });

  it("persists a one-time proof before returning it and replays it with the current RPC id", async () => {
    const now = 1_788_000_100_000;
    const stateStore = createMemoryStarkscanProverStateStore(() => now);
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        jobId: JOB_ID,
        status: "succeeded",
        terminal: true,
        result: {
          proof: "one-time-proof",
          proof_facts: ["0xfact"],
          l2_to_l1_messages: [],
          additional_data: {
            signature: {
              issued_at: Math.floor(now / 1_000),
              sig_r: "0x1",
              sig_s: "0x2",
            },
          },
        },
      }),
    );

    await expect(
      relayStarkscanProverRequest(request(20), {
        endpoint: ENDPOINT,
        apiKey: "server-secret",
        fetchImpl,
        stateStore,
        now: () => now,
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { id: 20, result: { proof: "one-time-proof" } },
    });

    await expect(
      relayStarkscanProverRequest(request(21), {
        endpoint: ENDPOINT,
        apiKey: "server-secret",
        fetchImpl: vi.fn(() => {
          throw new Error("Starkscan must not be called for a cached proof");
        }),
        stateStore,
        now: () => now + 1_000,
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { id: 21, result: { proof: "one-time-proof" } },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rotates the idempotency key only after Starkscan reports a delivered or expired result", async () => {
    const now = 1_788_000_100_000;
    const stateStore = createMemoryStarkscanProverStateStore(() => now);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          jobId: JOB_ID,
          status: "succeeded",
          terminal: true,
          resultUnavailableReason: "delivered_or_expired",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          jobId: `prv_${"b".repeat(24)}`,
          status: "succeeded",
          terminal: true,
          result: {
            proof: "replacement-proof",
            proof_facts: [],
            l2_to_l1_messages: [],
          },
        }),
      );

    await expect(
      relayStarkscanProverRequest(request(30), {
        endpoint: ENDPOINT,
        apiKey: "server-secret",
        fetchImpl,
        stateStore,
        now: () => now,
      }),
    ).resolves.toMatchObject({ status: 503, retryAfter: "1" });

    await expect(
      relayStarkscanProverRequest(request(31), {
        endpoint: ENDPOINT,
        apiKey: "server-secret",
        fetchImpl,
        stateStore,
        now: () => now,
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { id: 31, result: { proof: "replacement-proof" } },
    });
    const firstHeaders = new Headers(fetchImpl.mock.calls[0]![1]?.headers);
    const secondHeaders = new Headers(fetchImpl.mock.calls[1]![1]?.headers);
    expect(firstHeaders.get("idempotency-key")).toMatch(
      /^privatepons-[0-9a-f]{64}$/,
    );
    expect(secondHeaders.get("idempotency-key")).toMatch(
      /^privatepons-[0-9a-f]{64}-r1$/,
    );
  });
});
