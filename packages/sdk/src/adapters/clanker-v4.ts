import { getTickFromMarketCapUSDC, type ClankerTokenV4 } from "clanker-sdk";
import { Clanker } from "clanker-sdk/v4";
import {
  concatHex,
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import type {
  AdapterContext,
  ExecutionCall,
  LaunchpadAdapter,
} from "../types.js";

export const CLANKER_V4_FACTORY: Record<8453 | 84532, Address> = {
  8453: "0xE85A59c628F7d27878ACeB4bf3b35733630083a9",
  84532: "0xE85A59c628F7d27878ACeB4bf3b35733630083a9",
};

export interface ClankerV4LaunchIntent {
  name: string;
  symbol: string;
  image?: string;
  salt?: Hex;
  description?: string;
  socialMediaUrls?: readonly { platform: string; url: string }[];
  pairedToken?: "WETH" | Address;
  pool?: ClankerV4PoolIntent;
  creatorRewardBps?: number;
  vault?: {
    percentage: number;
    lockupDuration: number;
    vestingDuration?: number;
  };
}

export interface ClankerV4PoolIntent {
  pairedToken: "WETH" | Address;
  tickIfToken0IsClanker: number;
  tickSpacing: number;
  positions: readonly {
    tickLower: number;
    tickUpper: number;
    positionBps: number;
  }[];
}

/** A one-position USDC pool using Clanker's documented market-cap tick math. */
export function createClankerV4UsdcPool(
  pairedToken: Address,
  startingMarketCapUsdc = 10_000,
  endingMarketCapUsdc = 1_000_000_000,
): ClankerV4PoolIntent {
  const tickSpacing = 200;
  const tickLower = getTickFromMarketCapUSDC(
    startingMarketCapUsdc,
    tickSpacing,
  );
  const tickUpper = getTickFromMarketCapUSDC(endingMarketCapUsdc, tickSpacing);
  return {
    pairedToken: getAddress(pairedToken),
    tickIfToken0IsClanker: tickLower,
    tickSpacing,
    positions: [{ tickLower, tickUpper, positionBps: 10_000 }],
  };
}

export interface ClankerV4LaunchAdapterConfig {
  builder?: {
    admin: Address;
    recipient: Address;
  };
  interfaceName?: string;
  /** Pre-encoded suffix such as a Base builder code. Appended exactly as Clanker's SDK does. */
  dataSuffix?: Hex;
}

export interface PreparedClankerV4Launch {
  call: ExecutionCall;
  expectedToken: Address;
}

/**
 * Produces the Clanker SDK token object while forcing every creator-controlled
 * role onto the fresh private position account. Root-wallet provenance is never
 * accepted as input, so it cannot leak into Clanker's public metadata.
 */
export function buildClankerV4TokenConfig(
  chainId: 8453 | 84532,
  intent: ClankerV4LaunchIntent,
  context: Pick<AdapterContext, "account">,
  config: ClankerV4LaunchAdapterConfig = {},
): ClankerTokenV4 {
  validateIntent(intent, config);
  const creatorRewardBps = intent.creatorRewardBps ?? 10_000;
  const rewards: NonNullable<ClankerTokenV4["rewards"]>["recipients"] = [];
  if (creatorRewardBps > 0) {
    rewards.push({
      admin: context.account,
      recipient: context.account,
      bps: creatorRewardBps,
      token: "Both",
    });
  }
  if (creatorRewardBps < 10_000) {
    rewards.push({
      admin: config.builder!.admin,
      recipient: config.builder!.recipient,
      bps: 10_000 - creatorRewardBps,
      token: "Both",
    });
  }

  const socialMediaUrls = intent.socialMediaUrls?.map((item) => ({
    platform: item.platform,
    url: item.url,
  }));
  return {
    name: intent.name.trim(),
    symbol: intent.symbol.trim().toUpperCase(),
    image: intent.image ?? "",
    chainId,
    tokenAdmin: context.account,
    ...(intent.salt ? { salt: intent.salt } : {}),
    ...(intent.description || socialMediaUrls
      ? {
          metadata: {
            ...(intent.description ? { description: intent.description } : {}),
            ...(socialMediaUrls ? { socialMediaUrls } : {}),
          },
        }
      : {}),
    context: { interface: config.interfaceName ?? "Private Clanker" },
    ...(intent.pool || intent.pairedToken
      ? {
          pool: intent.pool
            ? {
                ...intent.pool,
                positions: intent.pool.positions.map((position) => ({
                  ...position,
                })),
              }
            : {
                pairedToken: intent.pairedToken!,
                tickIfToken0IsClanker: -230400,
                tickSpacing: 200,
                positions: [
                  {
                    tickLower: -230400,
                    tickUpper: -120000,
                    positionBps: 10_000,
                  },
                ],
              },
        }
      : {}),
    ...(intent.vault
      ? {
          vault: {
            ...intent.vault,
            vestingDuration: intent.vault.vestingDuration ?? 0,
            recipient: context.account,
          },
        }
      : {}),
    rewards: { recipients: rewards },
  };
}

export async function prepareClankerV4Launch(
  chainId: 8453 | 84532,
  intent: ClankerV4LaunchIntent,
  context: Pick<AdapterContext, "account">,
  config: ClankerV4LaunchAdapterConfig = {},
  builder: Pick<Clanker, "getDeployTransaction"> = new Clanker(),
): Promise<PreparedClankerV4Launch> {
  const token = buildClankerV4TokenConfig(chainId, intent, context, config);
  const transaction = await builder.getDeployTransaction(token);
  if (transaction.chainId !== chainId) {
    throw new Error(
      `Clanker prepared chain ${transaction.chainId}, expected ${chainId}`,
    );
  }
  if (getAddress(transaction.address) !== CLANKER_V4_FACTORY[chainId]) {
    throw new Error("Clanker SDK returned an unexpected V4 factory");
  }
  if (!transaction.expectedAddress) {
    throw new Error("Clanker SDK did not return the expected token address");
  }
  const encoded = encodeFunctionData({
    abi: transaction.abi,
    functionName: transaction.functionName,
    args: transaction.args,
  } as never);
  const data = config.dataSuffix
    ? concatHex([encoded, config.dataSuffix])
    : encoded;
  return {
    call: {
      target: getAddress(transaction.address),
      value: transaction.value ?? 0n,
      data,
    },
    expectedToken: getAddress(transaction.expectedAddress),
  };
}

/** Current Clanker V4 token deployment through a private position account. */
export function clankerV4LaunchAdapter(
  chainId: 8453 | 84532,
  config: ClankerV4LaunchAdapterConfig = {},
): LaunchpadAdapter<ClankerV4LaunchIntent, never> {
  return {
    id: "clanker-v4",
    chainId,
    async buildOpenCalls(intent, context) {
      const prepared = await prepareClankerV4Launch(
        chainId,
        intent,
        context,
        config,
      );
      return [prepared.call];
    },
    async buildCloseCalls() {
      throw new Error("trade Clanker tokens through the Uniswap trade adapter");
    },
  };
}

function validateIntent(
  intent: ClankerV4LaunchIntent,
  config: ClankerV4LaunchAdapterConfig,
): void {
  if (!intent.name.trim()) throw new Error("Clanker token name is required");
  if (!/^[A-Z0-9]{2,10}$/.test(intent.symbol.trim().toUpperCase())) {
    throw new Error("Clanker symbol must be 2-10 letters or numbers");
  }
  if (intent.salt && !/^0x[0-9a-fA-F]{64}$/.test(intent.salt)) {
    throw new Error("Clanker salt must be bytes32");
  }
  if (intent.pool) validatePool(intent.pool);
  const creatorRewardBps = intent.creatorRewardBps ?? 10_000;
  if (
    !Number.isSafeInteger(creatorRewardBps) ||
    creatorRewardBps < 0 ||
    creatorRewardBps > 10_000
  ) {
    throw new Error("creator reward must be an integer from 0 to 10000 bps");
  }
  if (creatorRewardBps < 10_000 && !config.builder) {
    throw new Error("builder reward recipient is required for a reward split");
  }
}

function validatePool(pool: ClankerV4PoolIntent): void {
  if (
    !Number.isSafeInteger(pool.tickSpacing) ||
    pool.tickSpacing <= 0 ||
    pool.tickSpacing > 32_767
  ) {
    throw new Error("Clanker pool tick spacing is invalid");
  }
  if (
    !Number.isSafeInteger(pool.tickIfToken0IsClanker) ||
    pool.tickIfToken0IsClanker % pool.tickSpacing !== 0
  ) {
    throw new Error("Clanker starting tick must align with tick spacing");
  }
  if (pool.positions.length === 0) {
    throw new Error("Clanker pool needs at least one liquidity position");
  }
  let totalBps = 0;
  let hasStartingTick = false;
  for (const position of pool.positions) {
    if (
      !Number.isSafeInteger(position.tickLower) ||
      !Number.isSafeInteger(position.tickUpper) ||
      position.tickLower >= position.tickUpper ||
      position.tickLower % pool.tickSpacing !== 0 ||
      position.tickUpper % pool.tickSpacing !== 0
    ) {
      throw new Error("Clanker pool position ticks are invalid");
    }
    if (
      !Number.isSafeInteger(position.positionBps) ||
      position.positionBps <= 0
    ) {
      throw new Error("Clanker pool position bps are invalid");
    }
    totalBps += position.positionBps;
    hasStartingTick ||= position.tickLower === pool.tickIfToken0IsClanker;
  }
  if (totalBps !== 10_000) {
    throw new Error("Clanker pool position bps must total 10000");
  }
  if (!hasStartingTick) {
    throw new Error("Clanker pool positions must include the starting tick");
  }
}
