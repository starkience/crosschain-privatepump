import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import {
  ARBITRUM_NATIVE_USDC,
  ROBINHOOD_USDG,
  createRelayBatchReturnTransport,
  createRelayBridgeClient,
  createRelayFundingTransport,
  createRelayReturnTransport,
  derivePrivateReturnSignature,
  type RelayFundingStorage,
} from "./relay-bridge.js";
import type {
  PrivacyBridgeEngine,
  SessionFundingTransportArgs,
} from "./types.js";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;
const CONNECTED = "0x3333333333333333333333333333333333333333" as Address;
const DEPOSIT = "0x4444444444444444444444444444444444444444" as Address;
const DESTINATION_TX = `0x${"55".repeat(32)}`;

function transferData(recipient: Address, amount: bigint): `0x${string}` {
  return `0xa9059cbb${recipient.slice(2).padStart(64, "0")}${amount
    .toString(16)
    .padStart(64, "0")}`;
}

function quote(amount = 999_000n) {
  return {
    requestId: `0x${"ab".repeat(32)}`,
    details: {
      currencyIn: {
        currency: { chainId: 42161, address: ARBITRUM_NATIVE_USDC },
        amount: amount.toString(),
      },
      currencyOut: {
        currency: { chainId: 4663, address: ROBINHOOD_USDG },
        amount: "995000",
        minimumAmount: "990000",
      },
      timeEstimate: 20,
    },
    steps: [
      {
        id: "deposit",
        items: [
          {
            data: {
              chainId: 42161,
              from: OWNER,
              to: ARBITRUM_NATIVE_USDC,
              data: transferData(DEPOSIT, amount),
              value: "0",
            },
          },
        ],
      },
    ],
  };
}

function reverseQuote(amount = 30_000_000n) {
  return {
    requestId: `0x${"cd".repeat(32)}`,
    privatePonsAttestation: "v1.payload.signature",
    details: {
      currencyIn: {
        currency: { chainId: 4663, address: ROBINHOOD_USDG },
        amount: amount.toString(),
      },
      currencyOut: {
        currency: { chainId: 42161, address: ARBITRUM_NATIVE_USDC },
        amount: "29637540",
        minimumAmount: "29341164",
      },
      timeEstimate: 20,
    },
    steps: [
      {
        id: "deposit",
        items: [
          {
            data: {
              chainId: 4663,
              from: CONNECTED,
              to: ROBINHOOD_USDG,
              data: transferData(DEPOSIT, amount),
              value: "0",
            },
          },
        ],
      },
    ],
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class MemoryStorage implements RelayFundingStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("Relay cross-chain bridge", () => {
  it("requests a strict deposit quote and validates its ERC-20 transfer", async () => {
    const doFetch = vi.fn(async () => json(quote()));
    const client = createRelayBridgeClient({ fetch: doFetch });
    await expect(
      client.quoteArbitrumUsdcToRobinhoodUsdg({
        user: OWNER,
        recipient: ACCOUNT,
        refundTo: OWNER,
        amount: 999_000n,
      }),
    ).resolves.toMatchObject({
      inputAmount: 999_000n,
      outputAmount: 995_000n,
      minimumOutputAmount: 990_000n,
      depositAddress: DEPOSIT,
    });

    const request = JSON.parse(String(doFetch.mock.calls[0]![1]?.body));
    expect(request).toMatchObject({
      originChainId: 42161,
      destinationChainId: 4663,
      recipient: ACCOUNT,
      useDepositAddress: true,
      strict: true,
    });
  });

  it("rejects a quote whose strict transfer amount was changed", async () => {
    const changed = quote();
    changed.steps[0]!.items[0]!.data.data = transferData(DEPOSIT, 1n);
    const client = createRelayBridgeClient({
      fetch: async () => json(changed),
    });
    await expect(
      client.quoteArbitrumUsdcToRobinhoodUsdg({
        user: OWNER,
        recipient: ACCOUNT,
        refundTo: OWNER,
        amount: 999_000n,
      }),
    ).rejects.toThrow(/calldata changed/);
  });

  it("requests the reverse Robinhood deposit route with an Arbitrum gas top-up", async () => {
    const doFetch = vi.fn(async () => json(reverseQuote()));
    const client = createRelayBridgeClient({ fetch: doFetch });
    await expect(
      client.quoteRobinhoodUsdgToArbitrumUsdc({
        user: CONNECTED,
        recipient: OWNER,
        refundTo: CONNECTED,
        amount: 30_000_000n,
      }),
    ).resolves.toMatchObject({
      inputAmount: 30_000_000n,
      outputAmount: 29_637_540n,
      minimumOutputAmount: 29_341_164n,
      depositAddress: DEPOSIT,
    });

    const request = JSON.parse(String(doFetch.mock.calls[0]![1]?.body));
    expect(request).toMatchObject({
      originChainId: 4663,
      destinationChainId: 42161,
      recipient: OWNER,
      strict: true,
      topupGas: true,
      topupGasAmount: "250000",
    });
  });

  it("can omit repeated destination gas top-ups", async () => {
    const doFetch = vi.fn(async () => json(reverseQuote()));
    const client = createRelayBridgeClient({ fetch: doFetch });
    await client.quoteRobinhoodUsdgToArbitrumUsdc({
      user: CONNECTED,
      recipient: OWNER,
      refundTo: CONNECTED,
      amount: 30_000_000n,
      topupGas: false,
    });
    const request = JSON.parse(String(doFetch.mock.calls[0]![1]?.body));
    expect(request).not.toHaveProperty("topupGas");
    expect(request).not.toHaveProperty("topupGasAmount");
  });

  it("domain-separates the private S2 return identity by position", () => {
    const root = "0x1234";
    const first = derivePrivateReturnSignature(root, 1);
    const second = derivePrivateReturnSignature(root, 2);
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first).not.toBe(root);
    expect(first).not.toBe(second);
    expect(derivePrivateReturnSignature(root, 1)).toBe(first);
  });

  it("carries the Relay request ID into the policy-relayer return batch", async () => {
    const relayRequestId = `0x${"cd".repeat(32)}`;
    const relayQuoteAttestation = "v1.payload.signature";
    const submitCalls = vi.fn(async () => {
      throw new Error("stop after submission capture");
    });
    const transport = createRelayReturnTransport({
      relay: {
        quoteRobinhoodUsdgToArbitrumUsdc: vi.fn(async () => ({
          requestId: relayRequestId,
          quoteAttestation: relayQuoteAttestation,
          inputAmount: 30_000_000n,
          outputAmount: 29_637_540n,
          minimumOutputAmount: 29_341_164n,
          depositAddress: DEPOSIT,
          depositTransaction: {
            chainId: 4663,
            from: ACCOUNT,
            to: ROBINHOOD_USDG,
            data: transferData(DEPOSIT, 30_000_000n),
            value: "0x0",
          },
        })),
        quoteArbitrumUsdcToRobinhoodUsdg: vi.fn(),
        getStatus: vi.fn(),
        waitForSuccess: vi.fn(),
      },
    });
    const bridge = {
      deriveStarknetAddress: vi.fn(() => "0x1234"),
      sendPrivateToStarknet: vi.fn(),
      deriveEvmOwner: vi.fn(() => ({
        address: OWNER,
        privateKey: `0x${"12".repeat(32)}`,
      })),
    } as unknown as PrivacyBridgeEngine;

    await expect(
      transport({
        bridge,
        signature: `0x${"34".repeat(65)}`,
        session: {
          owner: OWNER,
          account: ACCOUNT,
          accountIndex: 2,
          channel: "pons-private-v1",
        },
        connectedEvmAddress: CONNECTED,
        amount: 30_000_000n,
        submitCalls,
        waitForExecution: vi.fn(),
      }),
    ).rejects.toThrow(/stop after submission capture/);
    expect(submitCalls).toHaveBeenCalledWith(
      [
        {
          target: ROBINHOOD_USDG,
          value: 0n,
          data: transferData(DEPOSIT, 30_000_000n),
        },
      ],
      { relayRequestId, relayQuoteAttestation },
    );
  });

  it("shares one destination gas top-up across a multi-account return", async () => {
    const secondAccount =
      "0x5555555555555555555555555555555555555555" as Address;
    let usdcRead = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === "eth_getBalance") {
          return json({ jsonrpc: "2.0", id: 1, result: "0x0" });
        }
        if (body.method === "eth_call") {
          usdcRead += 1;
          return json({
            jsonrpc: "2.0",
            id: 1,
            result: usdcRead === 1 ? "0x0" : "0x1e8480",
          });
        }
        throw new Error(`unexpected RPC method ${body.method}`);
      }),
    );
    const quoteReturn = vi.fn(
      async (args: { user: Address; amount: bigint; topupGas?: boolean }) => ({
        requestId: `0x${"cd".repeat(32)}`,
        quoteAttestation: "v1.payload.signature",
        inputAmount: args.amount,
        outputAmount: args.amount,
        minimumOutputAmount: args.amount - 1n,
        depositAddress: DEPOSIT,
        depositTransaction: {
          chainId: 4663,
          from: args.user,
          to: ROBINHOOD_USDG,
          data: transferData(DEPOSIT, args.amount),
          value: "0x0" as const,
        },
      }),
    );
    const secondSubmit = vi.fn(async () => {
      throw new Error("stop on second source");
    });
    const transport = createRelayBatchReturnTransport({
      arbitrumRpcUrl: "https://arb.test",
      relay: {
        quoteRobinhoodUsdgToArbitrumUsdc: quoteReturn,
        quoteArbitrumUsdcToRobinhoodUsdg: vi.fn(),
        getStatus: vi.fn(),
        waitForSuccess: vi.fn(async () => ({
          status: "success",
          terminal: true,
          succeeded: true,
        })),
      },
    });
    const bridge = {
      deriveStarknetAddress: vi.fn(() => "0x1234"),
      sendPrivateToStarknet: vi.fn(),
      deriveEvmOwner: vi.fn(() => ({
        address: OWNER,
        privateKey: `0x${"12".repeat(32)}`,
      })),
    } as unknown as PrivacyBridgeEngine;
    const confirmed = vi.fn(async () => ({
      transactionHash: DESTINATION_TX as `0x${string}`,
      status: "success" as const,
      blockNumber: 1n,
    }));

    await expect(
      transport({
        bridge,
        signature: `0x${"34".repeat(65)}`,
        connectedEvmAddress: CONNECTED,
        sources: [
          {
            session: {
              owner: OWNER,
              account: ACCOUNT,
              accountIndex: 1,
              channel: "pons-private-v1",
            },
            amount: 2_000_000n,
            submitCalls: vi.fn(async () => DESTINATION_TX as `0x${string}`),
            waitForExecution: confirmed,
          },
          {
            session: {
              owner: CONNECTED,
              account: secondAccount,
              accountIndex: 2,
              channel: "pons-private-v1",
            },
            amount: 1_000_000n,
            submitCalls: secondSubmit,
            waitForExecution: confirmed,
          },
        ],
      }),
    ).rejects.toThrow(/stop on second source/);
    expect(quoteReturn.mock.calls.map(([args]) => args.topupGas)).toEqual([
      true,
      false,
    ]);
    expect(secondSubmit).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("keeps small returned positions recoverable when Relay fees are too high", async () => {
    const transport = createRelayReturnTransport({
      relay: {
        quoteRobinhoodUsdgToArbitrumUsdc: vi.fn(async () => {
          throw new Error(
            "Relay quote failed with HTTP 400: Amount too low to cover swap fees and gas top up",
          );
        }),
        quoteArbitrumUsdcToRobinhoodUsdg: vi.fn(),
        getStatus: vi.fn(),
        waitForSuccess: vi.fn(),
      },
    });
    const bridge = {
      deriveStarknetAddress: vi.fn(() => "0x1234"),
      sendPrivateToStarknet: vi.fn(),
      deriveEvmOwner: vi.fn(() => ({
        address: OWNER,
        privateKey: `0x${"12".repeat(32)}`,
      })),
    } as unknown as PrivacyBridgeEngine;

    await expect(
      transport({
        bridge,
        signature: `0x${"34".repeat(65)}`,
        session: {
          owner: OWNER,
          account: ACCOUNT,
          accountIndex: 2,
          channel: "pons-private-v1",
        },
        connectedEvmAddress: CONNECTED,
        amount: 700_000n,
        submitCalls: vi.fn(),
        waitForExecution: vi.fn(),
      }),
    ).rejects.toThrow(
      /cannot return 0\.7 USDG.*funds remain in the fresh Robinhood account/i,
    );
  });

  it("persists the burn before polling and returns the protected USDG amount", async () => {
    const storage = new MemoryStorage();
    const waitForSuccess = vi.fn(async () => {
      expect(
        [...storage.values.entries()].every(
          ([key, value]) =>
            !key.toLowerCase().includes(CONNECTED.toLowerCase()) &&
            !value.toLowerCase().includes(CONNECTED.toLowerCase()),
        ),
      ).toBe(true);
      return {
        status: "success",
        terminal: true,
        succeeded: true,
        destinationTxHash: DESTINATION_TX as `0x${string}`,
      };
    });
    const bridgeOutToDeposit = vi.fn(async () => ({
      burnTxHash: "0xabc",
      mintRecipient: DEPOSIT,
      eoaAddress: OWNER,
      commitmentH: 77n,
    }));
    const bridge = {
      quoteCctpOut: vi.fn(async () => ({
        maxFee: 1_000n,
        forwardFee: 900n,
        protocolFee: 100n,
        finalityThreshold: 1_000,
      })),
      bridgeOutToDeposit,
      deriveEvmOwner: vi.fn(() => ({
        address: OWNER,
        privateKey: `0x${"12".repeat(32)}`,
      })),
    } as unknown as PrivacyBridgeEngine;
    const transport = createRelayFundingTransport({
      storage,
      relay: {
        quoteArbitrumUsdcToRobinhoodUsdg: vi.fn(async () => ({
          requestId: `0x${"ab".repeat(32)}`,
          inputAmount: 999_000n,
          outputAmount: 995_000n,
          minimumOutputAmount: 990_000n,
          depositAddress: DEPOSIT,
          depositTransaction: {
            chainId: 42161,
            from: OWNER,
            to: ARBITRUM_NATIVE_USDC,
            data: transferData(DEPOSIT, 999_000n),
            value: "0x0" as const,
          },
        })),
        quoteRobinhoodUsdgToArbitrumUsdc: vi.fn(async () => ({
          requestId: `0x${"cd".repeat(32)}`,
          inputAmount: 990_000n,
          outputAmount: 975_000n,
          minimumOutputAmount: 965_000n,
          depositAddress: DEPOSIT,
          depositTransaction: {
            chainId: 4663,
            from: ACCOUNT,
            to: ROBINHOOD_USDG,
            data: transferData(DEPOSIT, 990_000n),
            value: "0x0" as const,
          },
        })),
        getStatus: vi.fn(),
        waitForSuccess,
      },
    });
    const args = {
      bridge,
      signature: "0x1234",
      session: {
        owner: OWNER,
        account: ACCOUNT,
        accountIndex: 2,
        channel: "private-launchpad-v1",
      },
      amount: 1_000_000n,
      connectedEvmAddress: CONNECTED,
      fast: true,
    } satisfies SessionFundingTransportArgs;

    const result = await transport(args);
    expect(bridgeOutToDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1_000_000n, destination: DEPOSIT }),
    );
    expect(result).toMatchObject({
      amountDelivered: 995_000n,
      minimumAmountDelivered: 990_000n,
      forwardTxHash: DESTINATION_TX,
      relayStatus: "success",
    });
    expect(storage.values.size).toBe(0);
  });

  it("rejects an unrecoverable funding amount before burning private funds", async () => {
    const bridgeOutToDeposit = vi.fn();
    const bridge = {
      quoteCctpOut: vi.fn(async () => ({
        maxFee: 1_000n,
        forwardFee: 900n,
        protocolFee: 100n,
        finalityThreshold: 1_000,
      })),
      bridgeOutToDeposit,
      deriveEvmOwner: vi.fn(() => ({
        address: OWNER,
        privateKey: `0x${"12".repeat(32)}`,
      })),
    } as unknown as PrivacyBridgeEngine;
    const transport = createRelayFundingTransport({
      storage: new MemoryStorage(),
      relay: {
        quoteArbitrumUsdcToRobinhoodUsdg: vi.fn(async () => ({
          requestId: `0x${"ab".repeat(32)}`,
          inputAmount: 999_000n,
          outputAmount: 705_000n,
          minimumOutputAmount: 700_000n,
          depositAddress: DEPOSIT,
          depositTransaction: {
            chainId: 42161,
            from: OWNER,
            to: ARBITRUM_NATIVE_USDC,
            data: transferData(DEPOSIT, 999_000n),
            value: "0x0" as const,
          },
        })),
        quoteRobinhoodUsdgToArbitrumUsdc: vi.fn(async () => ({
          requestId: `0x${"cd".repeat(32)}`,
          inputAmount: 700_000n,
          outputAmount: 96_964n,
          minimumOutputAmount: 95_995n,
          depositAddress: DEPOSIT,
          depositTransaction: {
            chainId: 4663,
            from: ACCOUNT,
            to: ROBINHOOD_USDG,
            data: transferData(DEPOSIT, 700_000n),
            value: "0x0" as const,
          },
        })),
        getStatus: vi.fn(),
        waitForSuccess: vi.fn(),
      },
    });

    await expect(
      transport({
        bridge,
        signature: "0x1234",
        session: {
          owner: OWNER,
          account: ACCOUNT,
          accountIndex: 2,
          channel: "private-launchpad-v1",
        },
        amount: 1_000_000n,
        connectedEvmAddress: CONNECTED,
        fast: true,
      }),
    ).rejects.toThrow(
      /recovery preflight failed before any funds moved.*only 0\.095995 USDC.*more than 0\.5 USDC.*Increase/i,
    );
    expect(bridgeOutToDeposit).not.toHaveBeenCalled();
  });
});
