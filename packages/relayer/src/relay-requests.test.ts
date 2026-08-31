import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { ARBITRUM_NATIVE_USDC, ROBINHOOD_USDG } from "@private-launchpad/sdk";
import {
  createRelayReturnVerifier,
  validateRelayReturnRequest,
  type RelayReturnBinding,
} from "./relay-requests.js";

const REQUEST_ID = `0x${"ab".repeat(32)}`;
const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const OWNER = "0x2222222222222222222222222222222222222222" as Address;
const DEPOSIT = "0x3333333333333333333333333333333333333333" as Address;
const RECIPIENT = "0x4444444444444444444444444444444444444444" as Address;
const NOW = Date.parse("2026-08-31T10:00:00.000Z");

const binding: RelayReturnBinding = {
  requestId: REQUEST_ID,
  account: ACCOUNT,
  owner: OWNER,
  depositAddress: DEPOSIT,
  amount: 25_000_000n,
};

function response() {
  return {
    requests: [
      {
        id: REQUEST_ID,
        status: "waiting",
        user: ACCOUNT,
        recipient: RECIPIENT,
        refundTo: OWNER,
        depositAddress: { address: DEPOSIT, type: "strict" },
        data: {
          route: {
            quoted: {
              origin: {
                inputCurrency: {
                  currency: {
                    chainId: 4663,
                    address: ROBINHOOD_USDG,
                  },
                  amount: "25000000",
                },
              },
              destination: {
                outputCurrency: {
                  currency: {
                    chainId: 42161,
                    address: ARBITRUM_NATIVE_USDC,
                  },
                  amount: "24600000",
                  minimumAmount: "24300000",
                },
              },
            },
          },
        },
        createdAt: "2026-08-31T09:55:00.000Z",
      },
    ],
  };
}

describe("Relay return request verification", () => {
  it("uses the authenticated request lookup and accepts an exact strict quote", async () => {
    const fetchImpl = vi.fn(async () => Response.json(response()));
    const verify = createRelayReturnVerifier({
      apiKey: "server-key",
      fetch: fetchImpl,
      now: () => NOW,
    });

    await expect(verify(binding)).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain(`/requests/v3?id=${REQUEST_ID}`);
    expect(init?.headers).toMatchObject({ "x-api-key": "server-key" });
  });

  it("rejects a quote for a different deposit address or amount", () => {
    expect(() =>
      validateRelayReturnRequest(
        response(),
        {
          ...binding,
          depositAddress:
            "0x5555555555555555555555555555555555555555" as Address,
        },
        NOW,
      ),
    ).toThrow(/strict deposit address/);
    expect(() =>
      validateRelayReturnRequest(response(), { ...binding, amount: 1n }, NOW),
    ).toThrow(/amount does not match/);
  });

  it("rejects stale, non-strict, or already completed requests", () => {
    const stale = response();
    stale.requests[0]!.createdAt = "2026-08-31T09:00:00.000Z";
    expect(() => validateRelayReturnRequest(stale, binding, NOW)).toThrow(
      /age window/,
    );

    const flexible = response();
    flexible.requests[0]!.depositAddress.type = "open";
    expect(() => validateRelayReturnRequest(flexible, binding, NOW)).toThrow(
      /strict deposit address/,
    );

    const completed = response();
    completed.requests[0]!.status = "success";
    expect(() => validateRelayReturnRequest(completed, binding, NOW)).toThrow(
      /not executable/,
    );
  });
});
