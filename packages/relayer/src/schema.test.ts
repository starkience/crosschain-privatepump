import { describe, expect, it } from "vitest";
import { parseRelayRequest, relayRequestJson } from "./schema.js";
import { validateStaticPolicy } from "./relayer.js";
import type { RelayExecutionRequest } from "@private-launchpad/sdk";

const request: RelayExecutionRequest = {
  chainId: 84532,
  factory: "0x1111111111111111111111111111111111111111",
  account: "0x2222222222222222222222222222222222222222",
  owner: "0x3333333333333333333333333333333333333333",
  accountIndex: 0,
  calls: [
    {
      target: "0x4444444444444444444444444444444444444444",
      value: 0n,
      data: "0x1234",
    },
  ],
  nonce: 0n,
  deadline: 2_000_000_000n,
  prefund: 0n,
  fee: {
    token: "0x0000000000000000000000000000000000000000",
    amount: 0n,
    recipient: "0x0000000000000000000000000000000000000000",
  },
  signature: `0x${"11".repeat(65)}`,
  relayRequestId: `0x${"aa".repeat(32)}`,
};

describe("relayer request boundary", () => {
  it("round-trips bigint fields through JSON", () => {
    expect(parseRelayRequest(relayRequestJson(request))).toEqual(request);
  });

  it("rejects malformed Relay request IDs", () => {
    expect(() =>
      parseRelayRequest({
        ...relayRequestJson(request),
        relayRequestId: "quote-1",
      }),
    ).toThrow(/32-byte hex/);
  });

  it("enforces target allowlists and deadlines", () => {
    const policy = {
      chainId: 84532,
      factory: request.factory,
      fee: request.fee,
      maxCalls: 4,
      maxCalldataBytes: 100,
      maxDeadlineSeconds: 1_000_000_000,
      maxPrefund: 0n,
      allowedTargets: new Set([request.calls[0]!.target.toLowerCase()]),
    };
    expect(() =>
      validateStaticPolicy(request, policy, 1_500_000_000),
    ).not.toThrow();
    expect(() =>
      validateStaticPolicy(
        {
          ...request,
          calls: [{ ...request.calls[0]!, target: request.owner }],
        },
        policy,
        1_500_000_000,
      ),
    ).toThrow(/not allowed/);
  });
});
