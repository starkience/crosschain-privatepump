import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { clankerV31Abi, clankerV31LaunchAdapter } from "./clanker-v31.js";

const PRIVATE_ACCOUNT = "0x1111111111111111111111111111111111111111";

describe("Clanker v3.1 adapter", () => {
  it("forces creator administration and rewards to the private account", async () => {
    const adapter = clankerV31LaunchAdapter(84532);
    const [call] = await adapter.buildOpenCalls(
      {
        token: {
          name: "Private Meme",
          symbol: "PMEME",
          salt: `0x${"22".repeat(32)}`,
          image: "ipfs://image",
          metadata: "ipfs://metadata",
          context: "private-launchpad",
        },
        vault: { percentage: 0, duration: 0n },
        pool: {
          pairedToken: "0x2222222222222222222222222222222222222222",
          tickIfToken0IsNewToken: -230400,
        },
        initialBuy: {
          value: 1n,
          pairedTokenPoolFee: 500,
          pairedTokenSwapAmountOutMinimum: 0n,
        },
        rewards: {
          creatorReward: 80n,
          interfaceAdmin: "0x3333333333333333333333333333333333333333",
          interfaceRewardRecipient:
            "0x4444444444444444444444444444444444444444",
        },
      },
      { account: PRIVATE_ACCOUNT, publicClient: {} as never },
    );
    expect(call?.value).toBe(1n);
    const decoded = decodeFunctionData({
      abi: clankerV31Abi,
      data: call!.data,
    });
    const config = decoded.args[0];
    expect(config.tokenConfig.originatingChainId).toBe(84532n);
    expect(config.rewardsConfig.creatorAdmin).toBe(PRIVATE_ACCOUNT);
    expect(config.rewardsConfig.creatorRewardRecipient).toBe(PRIVATE_ACCOUNT);
  });
});
