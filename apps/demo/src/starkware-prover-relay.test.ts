import { describe, expect, it, vi } from "vitest";
import { createMemoryStarkscanProverStateStore } from "./starkscan-prover-store.js";
import { relayStarkwareProverRequest } from "./starkware-prover-relay.js";

const ENDPOINT = "https://transaction-prover.alpha-mainnet.sw-dev.io/";
const POOL =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

function request(id: number, sender = POOL) {
  return {
    jsonrpc: "2.0",
    id,
    method: "starknet_proveTransaction",
    params: {
      block_id: { block_number: 14_000_000 },
      transaction: {
        type: "INVOKE",
        sender_address: sender,
        calldata: ["0x1"],
      },
    },
  };
}

describe("StarkWare prover relay", () => {
  it("forwards the SDK JSON-RPC request and caches the completed proof", async () => {
    const now = 1_788_000_000_000;
    const stateStore = createMemoryStarkscanProverStateStore(() => now);
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        jsonrpc: "2.0",
        id: 7,
        result: {
          proof: "proof-data",
          proof_facts: ["0xfact"],
          l2_to_l1_messages: [],
          additional_data: {
            signature: {
              issued_at: now / 1_000,
              sig_r: "0x1",
              sig_s: "0x2",
            },
          },
        },
      }),
    );

    await expect(
      relayStarkwareProverRequest(request(7), {
        endpoint: ENDPOINT,
        fetchImpl,
        stateStore,
        now: () => now,
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { jsonrpc: "2.0", id: 7, result: { proof: "proof-data" } },
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual(request(7));
    expect(new Headers(init.headers).has("x-starkscan-api-key")).toBe(false);

    await expect(
      relayStarkwareProverRequest(request(8), {
        endpoint: ENDPOINT,
        fetchImpl: async () => {
          throw new Error("completed proofs must come from the cache");
        },
        stateStore,
        now: () => now,
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { jsonrpc: "2.0", id: 8, result: { proof: "proof-data" } },
    });
  });

  it("returns an unknown-delivery timeout without retrying", async () => {
    const timeout = Object.assign(new Error("request timed out"), {
      name: "TimeoutError",
    });
    const fetchImpl = vi.fn().mockRejectedValue(timeout);

    await expect(
      relayStarkwareProverRequest(request(9), {
        endpoint: ENDPOINT,
        fetchImpl,
      }),
    ).resolves.toEqual({
      status: 504,
      body: {
        error:
          "StarkWare prover did not return before the request deadline. Proof delivery is unknown; do not start another public deposit.",
      },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects proof requests for anything except the STRK20 mainnet pool", async () => {
    const fetchImpl = vi.fn();
    await expect(
      relayStarkwareProverRequest(request(10, "0x123"), {
        endpoint: ENDPOINT,
        fetchImpl,
      }),
    ).rejects.toThrow(/sender must be the STRK20 mainnet pool/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a screening signature that cannot survive submission", async () => {
    const now = 1_788_000_000_000;
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        jsonrpc: "2.0",
        id: 11,
        result: {
          proof: "proof-data",
          additional_data: {
            signature: { issued_at: now / 1_000 - 280 },
          },
        },
      }),
    );

    await expect(
      relayStarkwareProverRequest(request(11), {
        endpoint: ENDPOINT,
        fetchImpl,
        stateStore: createMemoryStarkscanProverStateStore(() => now),
        now: () => now,
      }),
    ).resolves.toEqual({
      status: 503,
      body: {
        error:
          "StarkWare screening attestation is too close to expiry; rebuild the proof request",
      },
      retryAfter: "1",
    });
  });
});
