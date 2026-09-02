import { describe, expect, it, vi } from "vitest";
import type { RelayExecutionRequest } from "./types.js";
import {
  createHttpRelay,
  RelayerRejectedError,
  relayExecutionRequestJson,
} from "./relay-http.js";

const request: RelayExecutionRequest = {
  chainId: 84532,
  factory: "0x1111111111111111111111111111111111111111",
  account: "0x2222222222222222222222222222222222222222",
  owner: "0x3333333333333333333333333333333333333333",
  accountIndex: 4,
  calls: [
    {
      target: "0x4444444444444444444444444444444444444444",
      value: 7n,
      data: "0x1234",
    },
  ],
  nonce: 8n,
  deadline: 9n,
  prefund: 10n,
  fee: {
    token: "0x5555555555555555555555555555555555555555",
    amount: 11n,
    recipient: "0x6666666666666666666666666666666666666666",
  },
  signature: `0x${"12".repeat(65)}`,
  walletRecoveryAuthorization: {
    recipient: "0x7777777777777777777777777777777777777777",
    accounts: [
      {
        account: "0x2222222222222222222222222222222222222222",
        amount: 12n,
      },
    ],
    deadline: 13n,
    signature: `0x${"13".repeat(65)}`,
  },
};

describe("HTTP relay transport", () => {
  it("serializes every bigint using the relayer schema", () => {
    expect(relayExecutionRequestJson(request)).toMatchObject({
      calls: [{ value: "7" }],
      nonce: "8",
      deadline: "9",
      prefund: "10",
      fee: { amount: "11" },
      walletRecoveryAuthorization: {
        accounts: [{ amount: "12" }],
        deadline: "13",
      },
    });
    expect(() =>
      JSON.stringify(relayExecutionRequestJson(request)),
    ).not.toThrow();
  });

  it("posts without credentials or redirects and validates the transaction hash", async () => {
    const transactionHash = `0x${"ab".repeat(32)}` as const;
    const fetchImpl = vi.fn(async () =>
      Response.json({ transactionHash }, { status: 202 }),
    );
    const relay = createHttpRelay({
      endpoint: "/api/private-launchpad/v1/relay",
      fetch: fetchImpl,
    });

    await expect(relay(request)).resolves.toBe(transactionHash);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/private-launchpad/v1/relay",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }),
    );
  });

  it("surfaces bounded policy errors and rejects malformed success responses", async () => {
    const rejected = createHttpRelay({
      endpoint: "https://relay.example/v1/relay",
      fetch: async () =>
        Response.json(
          { error: "target not allowed", requestId: "relay-request-1" },
          { status: 400 },
        ),
    });
    await expect(rejected(request)).rejects.toThrow(/target not allowed/);
    await rejected(request).catch((error: unknown) => {
      expect(error).toBeInstanceOf(RelayerRejectedError);
      expect(error).toMatchObject({
        status: 400,
        requestId: "relay-request-1",
        broadcasted: false,
      });
    });

    const malformed = createHttpRelay({
      endpoint: "https://relay.example/v1/relay",
      fetch: async () =>
        Response.json({ transactionHash: "0x1234" }, { status: 202 }),
    });
    await expect(malformed(request)).rejects.toThrow(
      /invalid transaction hash/,
    );
  });

  it("requires HTTPS except for same-origin and local development", () => {
    expect(() =>
      createHttpRelay({ endpoint: "http://relay.example/v1/relay" }),
    ).toThrow(/must use HTTPS/);
    expect(() =>
      createHttpRelay({ endpoint: "https://user:pass@relay.example/v1/relay" }),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      createHttpRelay({ endpoint: "http://localhost:8787/v1/relay" }),
    ).not.toThrow();
  });
});
