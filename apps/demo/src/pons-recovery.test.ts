import { describe, expect, it, vi } from "vitest";
import {
  PONS_V2_ROBINHOOD,
  type PrivateLaunchpadClient,
} from "@private-launchpad/sdk";
import type { Address, PublicClient } from "viem";
import { recoverPonsPositions } from "./pons-recovery.js";

const FACTORY = "0x1111111111111111111111111111111111111111" as Address;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;
const OWNER = "0x3333333333333333333333333333333333333333" as Address;
const TOKEN = "0x4444444444444444444444444444444444444444" as Address;
const TX_HASH = `0x${"55".repeat(32)}` as const;

describe("Pons onchain position recovery", () => {
  it("matches a wallet-derived owner and rebuilds an open token position", async () => {
    const getLogs = vi.fn(async (request: { address?: Address }) => {
      if (request.address?.toLowerCase() === FACTORY.toLowerCase()) {
        return [
          {
            address: FACTORY,
            args: { account: ACCOUNT, owner: OWNER, index: 41n },
            blockNumber: 100n,
            transactionHash: TX_HASH,
          },
        ];
      }
      if (
        request.address?.toLowerCase() ===
        PONS_V2_ROBINHOOD.factory.toLowerCase()
      ) {
        return [];
      }
      return [
        {
          address: TOKEN,
          args: {
            from: "0x0000000000000000000000000000000000000000",
            to: ACCOUNT,
            value: 256_480n,
          },
          blockNumber: 101n,
          transactionHash: null,
        },
      ];
    });
    const readContract = vi.fn(
      async (request: { address: Address; functionName: string }) => {
        if (request.functionName === "balanceOf") return 256_480n;
        if (request.functionName === "getLaunchedToken") {
          return { exists: true, pairToken: PONS_V2_ROBINHOOD.usdg };
        }
        if (request.functionName === "name") return "$30 and a dream";
        if (request.functionName === "symbol") return "$30";
        if (request.functionName === "logo") return "ipfs://token-art";
        if (request.functionName === "description") return "Recovered";
        throw new Error(`unexpected read ${request.functionName}`);
      },
    );
    const publicClient = {
      getLogs,
      readContract,
      getBlock: vi.fn(async () => ({ timestamp: 1_700_000_000n })),
      getTransactionReceipt: vi.fn(),
    } as unknown as PublicClient;
    const deriveEvmOwner = vi.fn(() => ({ address: OWNER }));
    const client = {
      channel: "private-launchpad-v1",
      config: {
        factory: FACTORY,
        publicClient,
        bridge: { deriveEvmOwner },
      },
    } as unknown as PrivateLaunchpadClient;

    const positions = await recoverPonsPositions({
      client,
      signature: "0x1234",
    });

    expect(deriveEvmOwner).toHaveBeenCalledWith(
      "0x1234",
      41,
      "private-launchpad-v1",
    );
    expect(positions).toEqual([
      expect.objectContaining({
        kind: "trade",
        accountIndex: 41,
        account: ACCOUNT,
        token: TOKEN,
        name: "$30 and a dream",
        symbol: "30",
        status: "held",
        tokenAmount: "256480",
        usdcCommitted: "0",
        createdAt: 1_700_000_000_000,
      }),
    ]);
  });
});
