import { describe, expect, it, vi } from "vitest";
import type {
  LaunchpadAdapter,
  PrivateLaunchpadClient,
  PrivateLaunchpadSession,
} from "@private-launchpad/sdk";
import { createLiveRuntime, type LaunchDraft } from "./runtime.js";

const address =
  "0x1111111111111111111111111111111111111111" as PrivateLaunchpadSession["account"];
const session: PrivateLaunchpadSession = {
  accountIndex: 3,
  channel: "private-launchpad-v1",
  owner: "0x2222222222222222222222222222222222222222",
  account: "0x3333333333333333333333333333333333333333",
};
const draft: LaunchDraft = {
  name: "Night Market",
  symbol: "NITE",
  bridgeAmount: 25_000_000n,
  creatorReward: 40,
};

describe("live frontend runtime", () => {
  it("keeps the identity signature internal while calling the real SDK boundary", async () => {
    const deriveSession = vi.fn(async () => session);
    const fundSession = vi.fn(async () => ({ forwardTxHash: "0xfund" }));
    const open = vi.fn(async () => "0xlaunch");
    const client = {
      deriveSession,
      fundSession,
      open,
    } as unknown as PrivateLaunchpadClient;
    const adapter = { id: "host", chainId: 84532 } as LaunchpadAdapter<
      LaunchDraft,
      never
    >;
    const runtime = createLiveRuntime({
      appId: "launch.example",
      accountIndex: 3,
      client,
      adapter,
      connectWallet: async () => address,
      signIdentity: async ({ message }) => {
        expect(message).toContain("Application: launch.example");
        return "wallet-signature";
      },
      buildOpenIntent: (intent) => intent,
    });

    const identity = await runtime.prepareIdentity();
    expect(identity).toEqual({ connectedAddress: address, session });
    expect(JSON.stringify(identity)).not.toContain("wallet-signature");

    await runtime.fund(draft);
    await runtime.launch(draft);
    expect(deriveSession).toHaveBeenCalledWith("wallet-signature", 3);
    expect(fundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: "wallet-signature",
        connectedEvmAddress: address,
        amount: 25_000_000n,
      }),
    );
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: "wallet-signature",
        session,
        adapter,
      }),
    );
  });
});
