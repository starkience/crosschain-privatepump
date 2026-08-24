import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivateLaunchpadSession } from "@private-launchpad/sdk";
import { App } from "./App.js";
import type { LaunchpadRuntime } from "./runtime.js";

const session: PrivateLaunchpadSession = {
  accountIndex: 7,
  channel: "private-launchpad-v1",
  owner: "0x2222222222222222222222222222222222222222",
  account: "0x3333333333333333333333333333333333333333",
};

afterEach(cleanup);

function fixture() {
  const runtime: LaunchpadRuntime = {
    mode: "demo",
    prepareIdentity: vi.fn(async () => ({
      connectedAddress:
        "0x1111111111111111111111111111111111111111" as PrivateLaunchpadSession["account"],
      session,
    })),
    fund: vi.fn(async () => ({
      burnTxHash: "0xburn",
      accountIndex: 7,
      eoaAddress: session.owner,
      depositWallet: session.account,
      commitmentH: 1n,
      forwardTxHash: "0xfund",
    })),
    launch: vi.fn(async () => "0xlaunch"),
    returnToPool: vi.fn(async () => ({
      amountReturned: 24_200_000n,
      claimTxHash: "0xclaim",
      ranFreshBurn: true,
      alreadyClaimed: false,
    })),
    reset: vi.fn(),
  };
  render(<App runtime={runtime} />);
  return runtime;
}

describe("reference launchpad interface", () => {
  it("completes the private fund, launch, and return lifecycle", async () => {
    const runtime = fixture();

    fireEvent.click(
      screen.getByRole("button", { name: /prepare private launch/i }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: /relay launch to clanker/i,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: /simulate sell \+ return/i,
      }),
    );

    expect(
      await screen.findByRole("button", {
        name: /route complete — reset/i,
      }),
    ).toBeTruthy();
    expect(screen.getByText(/24\.2 USDC in a new note/i)).toBeTruthy();
    expect(runtime.prepareIdentity).toHaveBeenCalledOnce();
    expect(runtime.fund).toHaveBeenCalledOnce();
    expect(runtime.launch).toHaveBeenCalledOnce();
    expect(runtime.returnToPool).toHaveBeenCalledOnce();
  });

  it("leaves public submission with the host instead of simulating it", async () => {
    const runtime = fixture();

    fireEvent.click(screen.getByRole("button", { name: /^public$/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /continue with host wallet/i }),
    );

    expect(
      await screen.findByText(/public mode belongs to the host/i),
    ).toBeTruthy();
    await waitFor(() => expect(runtime.prepareIdentity).not.toHaveBeenCalled());
  });
});
