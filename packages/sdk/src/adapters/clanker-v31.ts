import { encodeFunctionData, type Address, type Hex } from "viem";
import type { LaunchpadAdapter } from "../types.js";

export const CLANKER_V31_FACTORY: Record<8453 | 84532, Address> = {
  8453: "0x2A787b2362021cC3eEa3C24C4748a6cD5B687382",
  84532: "0x2A787b2362021cC3eEa3C24C4748a6cD5B687382",
};

export const clankerV31Abi = [
  {
    type: "function",
    name: "deployToken",
    stateMutability: "payable",
    inputs: [
      {
        name: "deploymentConfig",
        type: "tuple",
        components: [
          {
            name: "tokenConfig",
            type: "tuple",
            components: [
              { name: "name", type: "string" },
              { name: "symbol", type: "string" },
              { name: "salt", type: "bytes32" },
              { name: "image", type: "string" },
              { name: "metadata", type: "string" },
              { name: "context", type: "string" },
              { name: "originatingChainId", type: "uint256" },
            ],
          },
          {
            name: "vaultConfig",
            type: "tuple",
            components: [
              { name: "vaultPercentage", type: "uint8" },
              { name: "vaultDuration", type: "uint256" },
            ],
          },
          {
            name: "poolConfig",
            type: "tuple",
            components: [
              { name: "pairedToken", type: "address" },
              { name: "tickIfToken0IsNewToken", type: "int24" },
            ],
          },
          {
            name: "initialBuyConfig",
            type: "tuple",
            components: [
              { name: "pairedTokenPoolFee", type: "uint24" },
              { name: "pairedTokenSwapAmountOutMinimum", type: "uint256" },
            ],
          },
          {
            name: "rewardsConfig",
            type: "tuple",
            components: [
              { name: "creatorReward", type: "uint256" },
              { name: "creatorAdmin", type: "address" },
              { name: "creatorRewardRecipient", type: "address" },
              { name: "interfaceAdmin", type: "address" },
              { name: "interfaceRewardRecipient", type: "address" },
            ],
          },
        ],
      },
    ],
    outputs: [
      { name: "tokenAddress", type: "address" },
      { name: "positionId", type: "uint256" },
    ],
  },
] as const;

export interface ClankerV31LaunchIntent {
  token: {
    name: string;
    symbol: string;
    salt: Hex;
    image: string;
    metadata: string;
    context: string;
  };
  vault: {
    percentage: number;
    duration: bigint;
  };
  pool: {
    pairedToken: Address;
    tickIfToken0IsNewToken: number;
  };
  initialBuy: {
    value: bigint;
    pairedTokenPoolFee: number;
    pairedTokenSwapAmountOutMinimum: bigint;
  };
  rewards: {
    creatorReward: bigint;
    interfaceAdmin: Address;
    interfaceRewardRecipient: Address;
  };
}

/// Concrete attachment to the existing Clanker v3.1 factory. Creator admin and
/// creator reward recipient are forced to the private account so a host UI cannot
/// accidentally put the connected/root wallet into public launch metadata.
export function clankerV31LaunchAdapter(
  chainId: 8453 | 84532,
  factory = CLANKER_V31_FACTORY[chainId],
): LaunchpadAdapter<ClankerV31LaunchIntent, never> {
  return {
    id: "clanker-v3.1",
    chainId,
    async buildOpenCalls(intent, context) {
      validateIntent(intent);
      const data = encodeFunctionData({
        abi: clankerV31Abi,
        functionName: "deployToken",
        args: [
          {
            tokenConfig: {
              ...intent.token,
              originatingChainId: BigInt(chainId),
            },
            vaultConfig: {
              vaultPercentage: intent.vault.percentage,
              vaultDuration: intent.vault.duration,
            },
            poolConfig: intent.pool,
            initialBuyConfig: {
              pairedTokenPoolFee: intent.initialBuy.pairedTokenPoolFee,
              pairedTokenSwapAmountOutMinimum:
                intent.initialBuy.pairedTokenSwapAmountOutMinimum,
            },
            rewardsConfig: {
              creatorReward: intent.rewards.creatorReward,
              creatorAdmin: context.account,
              creatorRewardRecipient: context.account,
              interfaceAdmin: intent.rewards.interfaceAdmin,
              interfaceRewardRecipient: intent.rewards.interfaceRewardRecipient,
            },
          },
        ],
      });
      return [{ target: factory, value: intent.initialBuy.value, data }];
    },
    async buildCloseCalls() {
      throw new Error(
        "Clanker launches trade on Uniswap V3; close through a DEX adapter",
      );
    },
  };
}

function validateIntent(intent: ClankerV31LaunchIntent): void {
  if (!intent.token.name.trim() || !intent.token.symbol.trim()) {
    throw new Error("Clanker token name and symbol are required");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(intent.token.salt)) {
    throw new Error("Clanker salt must be bytes32");
  }
  if (
    !Number.isInteger(intent.vault.percentage) ||
    intent.vault.percentage < 0 ||
    intent.vault.percentage > 100
  ) {
    throw new Error(
      "Clanker vault percentage must be an integer from 0 to 100",
    );
  }
  if (!Number.isSafeInteger(intent.pool.tickIfToken0IsNewToken)) {
    throw new Error("Clanker starting tick must be a safe integer");
  }
  if (
    !Number.isSafeInteger(intent.initialBuy.pairedTokenPoolFee) ||
    intent.initialBuy.pairedTokenPoolFee < 0
  ) {
    throw new Error(
      "Clanker paired-token pool fee must be a non-negative safe integer",
    );
  }
  if (intent.initialBuy.value < 0n)
    throw new Error("Clanker initial buy cannot be negative");
}
