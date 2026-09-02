import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RelayerRejectedError,
  type PrivateLaunchpadSession,
} from "@private-launchpad/sdk";
import { App } from "./App.js";
import type { LaunchpadRuntime } from "./runtime.js";

const session: PrivateLaunchpadSession = {
  accountIndex: 7,
  channel: "private-launchpad-v1",
  owner: "0x2222222222222222222222222222222222222222",
  account: "0x3333333333333333333333333333333333333333",
};
const LIVE_PONS_TOKEN = "0xD4f1C2Fb5eD5Ab256d41fefeC00fd40Dce6B7c86";
const ROBINHOOD_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function fixture(
  mode: "demo" | "live" = "demo",
  initialView: "launch" | "explore" = "launch",
  overrides: Partial<LaunchpadRuntime> = {},
) {
  const connectedAddress =
    "0x1111111111111111111111111111111111111111" as PrivateLaunchpadSession["account"];
  const runtime: LaunchpadRuntime = {
    mode,
    network: { name: "Base", chainId: 8453 },
    connectWallet: vi.fn(async () => connectedAddress),
    prepareIdentity: vi.fn(async () => ({
      connectedAddress,
      storageScope: `0x${"aa".repeat(32)}` as `0x${string}`,
      session,
    })),
    readPrivateBalance: vi.fn(async () => 0n),
    readPendingDeposit: vi.fn(async () => 0n),
    deposit: vi.fn(async (amount: bigint) => ({
      depositedNetWei: amount,
      deposited: true,
    })),
    resumeDeposit: vi.fn(async (amount: bigint) => ({
      depositedNetWei: amount,
      deposited: true,
    })),
    withdraw: vi.fn(async (amount: bigint, destination: string) => ({
      burnTxHash: "0xwithdrawburn",
      destination,
      forwardTxHash: "0xwithdrawmint",
      amountNet: amount,
    })),
    fund: vi.fn(async () => ({
      burnTxHash: "0xburn",
      accountIndex: 7,
      eoaAddress: session.owner,
      depositWallet: session.account,
      commitmentH: 1n,
      forwardTxHash: "0xfund",
    })),
    launch: vi.fn(async () => ({
      transactionHash: "0xlaunch",
      token:
        "0x4444444444444444444444444444444444444444" as PrivateLaunchpadSession["account"],
    })),
    waitForTransaction: vi.fn(async () => ({
      status: "success" as const,
      blockNumber: 123n,
    })),
    buy: vi.fn(async (draft) => ({
      transactionHash: "0xbuy",
      amountIn: draft.amountIn,
      amountOut: 1_240_000n * 10n ** 18n,
      minimumAmountOut: 1_227_600n * 10n ** 18n,
    })),
    sell: vi.fn(async (draft) => ({
      transactionHash: "0xsell",
      amountIn: draft.amountIn,
      amountOut: 24_200_000n,
      minimumAmountOut: 23_958_000n,
    })),
    readTokenBalance: vi.fn(async () => 1_240_000n * 10n ** 18n),
    readAccountTokenBalance: vi.fn(async () => 1_240_000n * 10n ** 18n),
    quoteBuy: vi.fn(async (_account, draft) => ({
      amountIn: draft.amountIn,
      amountOut: 1_240_000n * 10n ** 18n,
      minimumAmountOut: 1_227_600n * 10n ** 18n,
      calls: [],
    })),
    quoteSell: vi.fn(async (_account, draft) => ({
      amountIn: draft.amountIn,
      amountOut: 24_200_000n,
      minimumAmountOut: 23_958_000n,
      calls: [],
    })),
    returnToPool: vi.fn(async () => ({
      amountReturned: 24_200_000n,
      claimTxHash: "0xclaim",
      ranFreshBurn: true,
      alreadyClaimed: false,
    })),
    reset: vi.fn(),
    ...overrides,
  };
  render(<App runtime={runtime} />);
  if (initialView === "launch") {
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: /product navigation/i }),
      ).getByRole("button", { name: /^create$/i }),
    );
  }
  return runtime;
}

describe("Plank interface", () => {
  it("keeps primary actions available in the mobile navigation dock", () => {
    fixture("demo", "explore");

    const dock = screen.getByRole("navigation", { name: /mobile navigation/i });
    expect(
      within(dock)
        .getByRole("button", { name: /browse markets/i })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(dock).getByRole("button", { name: /open token launcher/i }),
    ).toBeTruthy();
    expect(
      within(dock).getByRole("button", { name: /open portfolio/i }),
    ).toBeTruthy();
    expect(
      within(dock)
        .getByRole("button", { name: /open private balance/i })
        .getAttribute("aria-haspopup"),
    ).toBe("dialog");
  });

  it("loads official Pons artwork and metadata without a Trade navigation tab", async () => {
    const readMarketMetadata = vi.fn(async (token: string) => {
      if (token.toLowerCase() !== LIVE_PONS_TOKEN.toLowerCase()) {
        throw new Error("metadata unavailable");
      }
      return {
        name: "PonsDonate onchain",
        symbol: "$PONSDONATE",
        logo: "ipfs://bafy-test-logo",
        description: "Onchain Pons metadata",
      };
    });
    fixture("live", "explore", { readMarketMetadata });

    expect(
      document.querySelector(
        'img[src="https://gateway.pinata.cloud/ipfs/bafkreibnqkvmyfznrhml2uw7mxfqbjyhdm6g4l43zmn2wythc7qbya4ybm"]',
      ),
    ).toBeTruthy();

    const navigation = screen.getByRole("navigation", {
      name: /product navigation/i,
    });
    expect(
      within(navigation).queryByRole("button", { name: /^trade$/i }),
    ).toBeNull();
    expect(await screen.findByText("PonsDonate onchain")).toBeTruthy();
    expect(screen.getByText("$PONSDONATE")).toBeTruthy();
    expect(
      document.querySelector(
        'img[src="https://gateway.pinata.cloud/ipfs/bafy-test-logo"]',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Private balance")).toBeNull();
  });

  it("opens a graduated token from the homepage", () => {
    const runtime = fixture("demo", "explore");

    const graduated = screen.getByRole("region", { name: /graduated/i });
    fireEvent.click(
      within(graduated).getAllByRole("button", { name: /Pons.*\$PONS/i })[0]!,
    );

    expect(screen.getAllByRole("heading", { name: "Pons" })).not.toHaveLength(
      0,
    );
    expect(screen.getByText(/graduated Pons market/i)).toBeTruthy();
    expect(
      screen.getByText(
        /private graduated-market trading is not supported yet/i,
      ),
    ).toBeTruthy();
    const tradeButton = screen.getByRole("button", {
      name: /graduated trading unavailable/i,
    }) as HTMLButtonElement;
    expect(tradeButton.disabled).toBe(true);
    expect(runtime.fund).not.toHaveBeenCalled();
  });

  it("opens a market from the new Explore surface", () => {
    const runtime = fixture("demo", "explore");

    expect(screen.getByRole("heading", { name: /^explore$/i })).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /night market/i }),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /night market/i }));

    expect(
      screen.getAllByRole("heading", { name: "Night Market" }),
    ).toHaveLength(2);
    expect(screen.getByRole("button", { name: /buy privately/i })).toBeTruthy();
    expect(runtime.reset).toHaveBeenCalledOnce();
  });

  it("keeps monetary inputs non-negative and immune to wheel or arrow stepping", () => {
    fixture("demo", "explore");
    fireEvent.click(screen.getByRole("button", { name: /night market/i }));

    const amount = screen.getByRole("spinbutton", {
      name: /usdc amount/i,
    }) as HTMLInputElement;
    expect(amount.classList.contains("numeric-amount-input")).toBe(true);

    fireEvent.change(amount, { target: { value: "-104" } });
    expect(amount.value).toBe("");
    expect(
      (
        screen.getByRole("button", {
          name: /buy privately/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    amount.focus();
    fireEvent.wheel(amount, { deltaY: 100 });
    expect(document.activeElement).not.toBe(amount);
    expect(fireEvent.keyDown(amount, { key: "ArrowDown" })).toBe(false);
  });

  it("keeps cleared deposit and buy amounts empty until a digit is typed", () => {
    fixture("demo", "explore");

    fireEvent.click(screen.getByRole("button", { name: /^deposit$/i }));
    const depositAmount = screen.getByRole("spinbutton", {
      name: /deposit amount/i,
    }) as HTMLInputElement;
    fireEvent.change(depositAmount, { target: { value: "" } });
    expect(depositAmount.value).toBe("");
    fireEvent.change(depositAmount, { target: { value: "5" } });
    expect(depositAmount.value).toBe("5");

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    fireEvent.click(screen.getByRole("button", { name: /night market/i }));
    const buyAmount = screen.getByRole("spinbutton", {
      name: /usdc amount/i,
    }) as HTMLInputElement;
    fireEvent.change(buyAmount, { target: { value: "" } });
    expect(buyAmount.value).toBe("");
    fireEvent.change(buyAmount, { target: { value: "5" } });
    expect(buyAmount.value).toBe("5");
  });

  it("removes legacy transaction activity from the page and storage", () => {
    localStorage.setItem(
      "plank-launch-activity-8453",
      JSON.stringify([
        {
          id: "stale-launch",
          name: "Private CR7",
          symbol: "SUI7",
          status: "preparing",
          createdAt: Date.now(),
          detail: "Moving private USDC to the fresh account",
        },
      ]),
    );

    fixture();

    expect(screen.queryByText(/transaction activity/i)).toBeNull();
    expect(screen.queryByText(/\$SUI7/i)).toBeNull();
    expect(localStorage.getItem("plank-launch-activity-8453")).toBeNull();
  });

  it("connects MetaMask explicitly in live mode", async () => {
    const runtime = fixture("live");

    fireEvent.click(screen.getByRole("button", { name: /connect metamask/i }));

    expect(
      await screen.findByRole("button", { name: /metamask connected/i }),
    ).toBeTruthy();
    expect(runtime.prepareIdentity).toHaveBeenCalledOnce();
    expect(runtime.readPrivateBalance).toHaveBeenCalledOnce();
    expect(runtime.readPendingDeposit).toHaveBeenCalledOnce();
  });

  it("restores the STRK20 balance after reconnecting", async () => {
    const runtime = fixture("live");
    vi.mocked(runtime.readPrivateBalance).mockResolvedValue(25_000_000n);

    fireEvent.click(screen.getByRole("button", { name: /connect metamask/i }));

    await screen.findByRole("button", { name: /metamask connected/i });
    expect(
      screen.getByText("Ready balance").closest(".summary-row")?.textContent,
    ).toContain("25 USDC");
  });

  it("finishes a pending Starknet deposit without creating a new Base burn", async () => {
    const runtime = fixture("live");
    vi.mocked(runtime.readPrivateBalance)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(25_000_000n);
    vi.mocked(runtime.readPendingDeposit)
      .mockResolvedValueOnce(25_000_000n)
      .mockResolvedValueOnce(25_000_000n)
      .mockResolvedValueOnce(0n);

    fireEvent.click(screen.getByRole("button", { name: /connect metamask/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /finish deposit/i }),
    );

    expect(await screen.findByText(/25 USDC resting/i)).toBeTruthy();
    expect(runtime.resumeDeposit).toHaveBeenCalledWith(
      25_000_000n,
      expect.any(Function),
    );
    expect(runtime.deposit).not.toHaveBeenCalled();
  });

  it("keeps an exhausted-prover deposit resumable without another public transfer", async () => {
    const runtime = fixture("live");
    vi.mocked(runtime.readPendingDeposit).mockResolvedValue(25_000_000n);
    vi.mocked(runtime.resumeDeposit).mockRejectedValue(
      new Error(
        'Proving service HTTP 429: {"code":"prover_daily_budget_exhausted","message":"Daily proof budget of 10 exhausted for this key","requestId":"mzk-test-request"}',
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /connect metamask/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /finish deposit/i }),
    );

    expect(
      await screen.findAllByText(/daily proof budget is exhausted/i),
    ).not.toHaveLength(0);
    expect(screen.getAllByText(/do not deposit again/i)).not.toHaveLength(0);
    expect(screen.getAllByText(/mzk-test-request/i)).not.toHaveLength(0);
    expect(
      screen.getByRole("button", { name: /finish deposit/i }),
    ).toBeTruthy();
    expect(screen.queryByText(/prover_daily_budget_exhausted/i)).toBeNull();
    expect(runtime.resumeDeposit).toHaveBeenCalledOnce();
    expect(runtime.deposit).not.toHaveBeenCalled();
  });

  it("keeps a timed-out StarkWare proof resumable without another public transfer", async () => {
    const runtime = fixture("live");
    vi.mocked(runtime.readPendingDeposit).mockResolvedValue(25_000_000n);
    vi.mocked(runtime.resumeDeposit).mockRejectedValue(
      new Error(
        'Proving service HTTP 504: {"error":"StarkWare prover did not return before the request deadline. Proof delivery is unknown; do not start another public deposit."}',
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /connect metamask/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /finish deposit/i }),
    );

    expect(
      await screen.findAllByText(
        /did not return before the safe request deadline/i,
      ),
    ).not.toHaveLength(0);
    expect(screen.getAllByText(/do not deposit again/i)).not.toHaveLength(0);
    expect(
      screen.getByRole("button", { name: /finish deposit/i }),
    ).toBeTruthy();
    expect(runtime.resumeDeposit).toHaveBeenCalledOnce();
    expect(runtime.deposit).not.toHaveBeenCalled();
  });

  it("treats post-deposit fee dust as complete instead of offering another resume", async () => {
    const runtime = fixture("live");
    vi.mocked(runtime.readPrivateBalance)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(2_648_102n);
    vi.mocked(runtime.readPendingDeposit)
      .mockResolvedValueOnce(2_648_473n)
      .mockResolvedValueOnce(2_648_473n)
      .mockResolvedValueOnce(371n);

    fireEvent.click(screen.getByRole("button", { name: /connect metamask/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /finish deposit/i }),
    );

    expect(await screen.findByText(/2\.65 USDC resting/i)).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: /finish STRK20 deposit/i }),
    ).toBeNull();
    expect(runtime.resumeDeposit).toHaveBeenCalledOnce();
    expect(runtime.deposit).not.toHaveBeenCalled();
  });

  it("reconciles a duplicate paymaster error after the pool deposit succeeds", async () => {
    const runtime = fixture("live");
    vi.mocked(runtime.readPrivateBalance)
      .mockResolvedValueOnce(24_935_484n)
      .mockResolvedValueOnce(49_870_727n);
    vi.mocked(runtime.readPendingDeposit)
      .mockResolvedValueOnce(25_000_000n)
      .mockResolvedValueOnce(25_000_000n)
      .mockResolvedValueOnce(0n);
    vi.mocked(runtime.resumeDeposit).mockRejectedValue(
      new Error("AVNU paymaster: Insufficient ERC20 balance"),
    );

    fireEvent.click(screen.getByRole("button", { name: /connect metamask/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /finish deposit/i }),
    );

    expect(await screen.findByText(/24\.94 USDC resting/i)).toBeTruthy();
    expect(
      screen.getByText("Ready balance").closest(".summary-row")?.textContent,
    ).toContain("24.94 USDC");
    expect(screen.queryByText(/insufficient erc20 balance/i)).toBeNull();
  });

  it("uses a real privacy switch and blocks launching while it is off", () => {
    fixture();
    const privacySwitch = screen.getByRole("switch", {
      name: /private launch/i,
    });
    const launchButton = screen.getByRole("button", {
      name: /launch privately/i,
    }) as HTMLButtonElement;

    expect(privacySwitch.getAttribute("aria-checked")).toBe("true");
    expect(launchButton.disabled).toBe(false);

    fireEvent.click(privacySwitch);
    expect(privacySwitch.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Private route off")).toBeTruthy();
    expect(launchButton.disabled).toBe(true);

    fireEvent.click(privacySwitch);
    expect(privacySwitch.getAttribute("aria-checked")).toBe("true");
    expect(launchButton.disabled).toBe(false);
  });

  it("expands and collapses token settings with accessible state", () => {
    fixture();
    const fees = screen.getByRole("button", { name: /fees/i });

    expect(fees.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fees);
    expect(fees.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fees);
    expect(fees.getAttribute("aria-expanded")).toBe("false");
  });

  it("rests a new STRK20 deposit before enabling a funded launch", async () => {
    const runtime = fixture("live");
    vi.mocked(runtime.readPrivateBalance)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(25_000_000n);
    expect(screen.getByText(/private launch through strk20/i)).toBeTruthy();
    const budgetPresets = screen.getByRole("group", {
      name: /common position budget/i,
    });
    expect(within(budgetPresets).getAllByRole("button")).toHaveLength(4);
    expect(
      screen.getByRole("button", { name: /connect metamask/i }),
    ).toBeTruthy();
    const depositButton = screen.getByRole("button", {
      name: /deposit to strk20/i,
    });
    expect(depositButton.textContent).toBe("Deposit");
    fireEvent.click(depositButton);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(
      (
        screen.getByRole("spinbutton", {
          name: /deposit amount/i,
        }) as HTMLInputElement
      ).value,
    ).toBe("25");
    expect(
      within(
        screen.getByRole("group", { name: /common deposit amounts/i }),
      ).getAllByRole("button"),
    ).toHaveLength(4);

    fireEvent.click(
      screen.getByRole("button", { name: /continue in wallet/i }),
    );

    const confirmed = await screen.findByText(/private funds are resting/i);
    const launchButton = screen.getByRole("button", {
      name: /launch privately/i,
    }) as HTMLButtonElement;
    expect(
      confirmed.closest(".privacy-deposit-state")?.getAttribute("data-ready"),
    ).toBe("false");
    expect(screen.getByText(/available for launch in [2-5]m/i)).toBeTruthy();
    expect(launchButton.disabled).toBe(true);
    expect(runtime.deposit).toHaveBeenCalledWith(
      25_000_000n,
      expect.any(Function),
      expect.any(Function),
    );
    expect(runtime.prepareIdentity).toHaveBeenCalledOnce();
  });

  it("accepts a custom private deposit amount", async () => {
    const runtime = fixture("demo", "explore");

    fireEvent.click(screen.getByRole("button", { name: /^deposit$/i }));
    const amount = screen.getByRole("spinbutton", {
      name: /deposit amount/i,
    });
    fireEvent.change(amount, { target: { value: "13" } });
    fireEvent.click(
      screen.getByRole("button", { name: /continue in wallet/i }),
    );

    await waitFor(() =>
      expect(runtime.deposit).toHaveBeenCalledWith(
        13_000_000n,
        expect.any(Function),
        expect.any(Function),
      ),
    );
  });

  it("shows a detailed process log with the submitted transaction", async () => {
    const runtime = fixture("demo", "explore");
    const submittedHash = `0x${"7".repeat(64)}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          result: { status: "0x1", blockNumber: "0x2e0e195" },
        }),
      })),
    );
    vi.mocked(runtime.deposit).mockImplementation(
      async (amount, onStep, onSubmitted) => {
        onStep?.("deploy", "running", "preparing Robinhood transfer");
        onSubmitted?.({
          burnTxHash: submittedHash,
          explorerUrl: `https://robinhoodchain.blockscout.com/tx/${submittedHash}`,
        });
        onStep?.("deploy", "done", "Relay transfer succeeded");
        onStep?.("register", "done", "Circle message registered");
        onStep?.("deposit", "done", "STRK20 note created");
        return { depositedNetWei: amount, deposited: true };
      },
    );

    fireEvent.click(screen.getByRole("button", { name: /^deposit$/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /continue in wallet/i }),
    );

    expect(
      await screen.findByRole("heading", { name: /transaction logger/i }),
    ).toBeTruthy();
    expect(await screen.findByText(/confirmed successfully/i)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /explorer/i }).getAttribute("href"),
    ).toBe(`https://robinhoodchain.blockscout.com/tx/${submittedHash}`);
    expect(screen.getByText(/STRK20 pool deposit/i)).toBeTruthy();
  });

  it("logs private-buy funding, relayer rejection, and recovery state", async () => {
    const runtime = fixture("demo", "explore");
    vi.mocked(runtime.buy).mockRejectedValue(
      new Error("relayer rejected execution with status 401: unauthorized"),
    );

    fireEvent.click(screen.getByRole("button", { name: /night market/i }));
    fireEvent.change(screen.getByRole("spinbutton", { name: /usdc amount/i }), {
      target: { value: "13" },
    });
    fireEvent.click(screen.getByRole("button", { name: /buy privately/i }));

    expect(
      await screen.findByRole("heading", { name: /transaction logger/i }),
    ).toBeTruthy();
    expect(screen.getByText(/Pons quote and execution/i)).toBeTruthy();
    expect(
      await screen.findAllByText(/no buy transaction was created/i),
    ).not.toHaveLength(0);
    expect(runtime.waitForTransaction).not.toHaveBeenCalled();
    expect(localStorage.getItem("privatepons-execution-process-v1")).toContain(
      "before broadcast",
    );
  });

  it("shows the useful reason from a multiline relayer rejection", async () => {
    const runtime = fixture("demo", "explore");
    vi.mocked(runtime.buy).mockRejectedValue(
      new RelayerRejectedError(
        400,
        'The contract function "deployAndExecute" reverted.\n\nReason: InsufficientAllowance()',
        "relay-request-multiline",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /night market/i }));
    fireEvent.click(screen.getByRole("button", { name: /buy privately/i }));

    expect(
      await screen.findAllByText(/Reason: InsufficientAllowance\(\)/i),
    ).not.toHaveLength(0);
    expect(screen.getAllByText(/relay-request-multiline/i)).not.toHaveLength(0);
  });

  it("waits for the live Robinhood balance and buys only the visible USDG", async () => {
    const readAccountTokenBalance = vi.fn(
      async (_account: string, token: string) =>
        token.toLowerCase() === ROBINHOOD_USDG.toLowerCase() ? 24_500_000n : 0n,
    );
    const runtime = fixture("live", "explore", {
      readPrivateBalance: vi.fn(async () => 25_000_000n),
      readAccountTokenBalance,
      fund: vi.fn(async () => ({
        burnTxHash: "0xburn",
        accountIndex: session.accountIndex,
        eoaAddress: session.owner,
        depositWallet: session.account,
        commitmentH: 1n,
        forwardTxHash: "0xfund",
        amountDelivered: 25_000_000n,
        minimumAmountDelivered: 24_000_000n,
      })),
    });

    fireEvent.click(screen.getByRole("button", { name: /connect metamask/i }));
    await screen.findByRole("button", { name: /metamask connected/i });
    fireEvent.click(screen.getByRole("button", { name: /PonsDonate/i }));
    fireEvent.click(screen.getByRole("button", { name: /buy privately/i }));

    await waitFor(() => expect(runtime.buy).toHaveBeenCalledOnce());
    expect(runtime.buy).toHaveBeenCalledWith(
      expect.objectContaining({ amountIn: 24_500_000n }),
    );
    expect(readAccountTokenBalance).toHaveBeenCalledWith(
      session.account,
      ROBINHOOD_USDG,
    );
  });

  it("rechecks the live USDG balance before retrying a rejected buy", async () => {
    let fundingBalanceRead = true;
    const readAccountTokenBalance = vi.fn(
      async (_account: string, token: string) => {
        if (token.toLowerCase() !== ROBINHOOD_USDG.toLowerCase()) return 0n;
        if (fundingBalanceRead) {
          fundingBalanceRead = false;
          return 25_000_000n;
        }
        return 12_000_000n;
      },
    );
    const runtime = fixture("live", "explore", {
      readPrivateBalance: vi.fn(async () => 25_000_000n),
      readAccountTokenBalance,
      fund: vi.fn(async () => ({
        burnTxHash: "0xburn",
        accountIndex: session.accountIndex,
        eoaAddress: session.owner,
        depositWallet: session.account,
        commitmentH: 1n,
        forwardTxHash: "0xfund",
        amountDelivered: 25_000_000n,
        minimumAmountDelivered: 25_000_000n,
      })),
    });
    vi.mocked(runtime.buy)
      .mockRejectedValueOnce(
        new RelayerRejectedError(400, "execution simulation failed", "first"),
      )
      .mockResolvedValueOnce({
        transactionHash: `0x${"9".repeat(64)}`,
        amountIn: 12_000_000n,
        amountOut: 1_240_000n * 10n ** 18n,
        minimumAmountOut: 1_227_600n * 10n ** 18n,
      });

    fireEvent.click(screen.getByRole("button", { name: /connect metamask/i }));
    await screen.findByRole("button", { name: /metamask connected/i });
    fireEvent.click(screen.getByRole("button", { name: /PonsDonate/i }));
    fireEvent.click(screen.getByRole("button", { name: /buy privately/i }));
    await screen.findAllByText(/execution simulation failed/i);

    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: /product navigation/i }),
      ).getByRole("button", { name: /positions/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /retry buy/i }));

    await waitFor(() => expect(runtime.buy).toHaveBeenCalledTimes(2));
    expect(runtime.buy).toHaveBeenLastCalledWith(
      expect.objectContaining({ amountIn: 12_000_000n }),
    );
    expect(runtime.quoteBuy).toHaveBeenLastCalledWith(
      session.account,
      expect.objectContaining({ amountIn: 12_000_000n }),
    );
  });

  it("reconciles an AVNU nonce-used response without a second public transfer", async () => {
    const runtime = fixture("demo", "explore");
    vi.mocked(runtime.deposit).mockRejectedValue(
      new Error(
        "AVNU paymaster paymaster_executeTransaction error (code 156): execution error argent/multicall-failed, Nonce already used, ENTRYPOINT_FAILED",
      ),
    );
    vi.mocked(runtime.readPendingDeposit).mockResolvedValue(3_000_000n);
    vi.mocked(runtime.readPrivateBalance).mockResolvedValue(0n);

    fireEvent.click(screen.getByRole("button", { name: /^deposit$/i }));
    fireEvent.change(
      screen.getByRole("spinbutton", { name: /deposit amount/i }),
      { target: { value: "3" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: /continue in wallet/i }),
    );

    expect(
      await screen.findByRole("heading", { name: /finish STRK20 deposit/i }),
    ).toBeTruthy();
    expect(screen.getByText(/ready to resume safely/i)).toBeTruthy();
    expect(screen.queryByText(/ENTRYPOINT_FAILED/i)).toBeNull();
    expect(runtime.deposit).toHaveBeenCalledOnce();
    expect(runtime.resumeDeposit).not.toHaveBeenCalled();
  });

  it("rejects an unavailable Pons curve before funding a fresh account", async () => {
    const runtime = fixture("demo", "explore", {
      quoteBuy: vi.fn(async () => {
        throw new Error(
          "This Pons market has graduated to V4; private graduated-market trading is not available yet",
        );
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: /night market/i }));
    fireEvent.click(screen.getByRole("button", { name: /buy privately/i }));

    expect(
      await screen.findAllByText(/graduated to V4.*not available yet/i),
    ).not.toHaveLength(0);
    expect(runtime.quoteBuy).toHaveBeenCalledOnce();
    expect(runtime.fund).not.toHaveBeenCalled();
    expect(runtime.buy).not.toHaveBeenCalled();
  });

  it("only offers launches funded through STRK20", async () => {
    const runtime = fixture();
    const launchButton = screen.getByRole("button", {
      name: /launch privately/i,
    }) as HTMLButtonElement;

    expect(screen.queryByRole("radio", { name: /without strk20/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /launch without strk20/i }),
    ).toBeNull();
    expect(launchButton.disabled).toBe(false);
    fireEvent.click(launchButton);

    expect(await screen.findByText(/new position/i)).toBeTruthy();
    expect(runtime.fund).toHaveBeenCalledOnce();
    expect(runtime.launch).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeAmount: 25_000_000n }),
    );
    expect(runtime.waitForTransaction).toHaveBeenCalledWith("0xlaunch");
    expect(runtime.waitForTransaction).toHaveBeenCalledWith("0xbuy");
    expect(runtime.buy).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "0x4444444444444444444444444444444444444444",
        amountIn: 25_000_000n,
      }),
    );
    const launchOrder = vi.mocked(runtime.launch).mock.invocationCallOrder[0]!;
    const confirmationOrders = vi.mocked(runtime.waitForTransaction).mock
      .invocationCallOrder;
    const buyOrder = vi.mocked(runtime.buy).mock.invocationCallOrder[0]!;
    expect(launchOrder).toBeLessThan(confirmationOrders[0]!);
    expect(confirmationOrders[0]!).toBeLessThan(buyOrder);
    expect(buyOrder).toBeLessThan(confirmationOrders[1]!);
    expect(screen.queryByText(/transaction activity/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /sell creator position/i }),
    ).toBeTruthy();
  });

  it("accepts only one launch while a click is in flight", async () => {
    const runtime = fixture();
    const launchButton = screen.getByRole("button", {
      name: /launch privately/i,
    });

    fireEvent.click(launchButton);
    fireEvent.click(launchButton);
    fireEvent.click(launchButton);

    await screen.findByText(/new position/i);
    expect(runtime.prepareIdentity).toHaveBeenCalledTimes(2);
    expect(runtime.launch).toHaveBeenCalledOnce();
    expect(runtime.waitForTransaction).toHaveBeenCalledTimes(2);
  });

  it("reports a pre-broadcast relayer rejection without an activity panel", async () => {
    const runtime = fixture();
    vi.mocked(runtime.launch).mockRejectedValue(
      new Error(
        "relayer rejected execution with status 400: The total cost exceeds the balance of the account",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /launch privately/i }));

    expect(await screen.findByText(/no transaction was created/i)).toBeTruthy();
    expect(screen.getByText(/relayer is out of Robinhood ETH/i)).toBeTruthy();
    expect(screen.queryByText(/transaction activity/i)).toBeNull();
    expect(runtime.waitForTransaction).not.toHaveBeenCalled();
  });

  it("reports relayer gas depletion and the rejection reference", async () => {
    const runtime = fixture("demo", "explore");
    vi.mocked(runtime.buy).mockRejectedValue(
      new RelayerRejectedError(
        400,
        "relayer gas account 0x833fd5f9a78806AFF3fF99fA5f6Ff423204F02CE has no Robinhood ETH",
        "relay-request-6",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /night market/i }));
    fireEvent.click(screen.getByRole("button", { name: /buy privately/i }));

    expect(
      await screen.findAllByText(/relayer is out of Robinhood ETH/i),
    ).not.toHaveLength(0);
    expect(screen.getAllByText(/relay-request-6/i)).not.toHaveLength(0);
    expect(
      screen.getAllByText(/USDG remains in the fresh account/i),
    ).not.toHaveLength(0);
    expect(runtime.waitForTransaction).not.toHaveBeenCalled();
  });

  it("opens the image picker and previews valid token artwork", async () => {
    fixture();
    const input = screen.getByLabelText("Token image") as HTMLInputElement;
    const openPicker = vi.spyOn(input, "click");

    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    expect(openPicker).toHaveBeenCalledOnce();

    fireEvent.change(input, {
      target: {
        files: [new File(["image"], "plank.png", { type: "image/png" })],
      },
    });

    expect(await screen.findByAltText("Selected token artwork")).toBeTruthy();
    expect(screen.getByText("plank.png")).toBeTruthy();
  });

  it("qualifies launcher privacy as onchain separation", () => {
    fixture();

    expect(
      screen.getByText(/original wallet is not linked onchain/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/browser and routing providers can still correlate/i),
    ).toBeTruthy();
  });

  it("launches from a fresh funded account and confirms the creator buy", async () => {
    const runtime = fixture();

    fireEvent.click(screen.getByRole("button", { name: /launch privately/i }));

    expect(
      await screen.findByRole("button", { name: /sell creator position/i }),
    ).toBeTruthy();
    expect(runtime.prepareIdentity).toHaveBeenCalledTimes(2);
    expect(runtime.fund).toHaveBeenCalledOnce();
    expect(runtime.fund).toHaveBeenCalledWith(expect.any(Object));
    expect(runtime.launch).toHaveBeenCalledOnce();
    expect(runtime.buy).toHaveBeenCalledOnce();
    expect(runtime.waitForTransaction).toHaveBeenCalledTimes(2);
    expect(runtime.returnToPool).not.toHaveBeenCalled();
  });

  it("makes the public deposit edge explicit and adds to Private Balance", async () => {
    const runtime = fixture("demo", "explore");
    vi.mocked(runtime.readPrivateBalance).mockResolvedValue(275_000_000n);

    fireEvent.click(screen.getAllByRole("button", { name: /^deposit$/i })[0]!);
    expect(
      screen.getByText(/Robinhood USDG → Relay → Arbitrum USDC → STRK20/i),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /continue in wallet/i }),
    );

    await waitFor(() =>
      expect(
        document.querySelector(".pons-private-balance")?.textContent,
      ).toContain("275 USDC"),
    );
    expect(runtime.deposit).toHaveBeenCalledWith(
      100_000_000n,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("withdraws Private Balance to a public EVM wallet", async () => {
    const runtime = fixture();

    fireEvent.click(screen.getByRole("button", { name: /^withdraw$/i }));
    expect(screen.getByText(/withdrawal destination.*public/i)).toBeTruthy();
    fireEvent.change(
      screen.getByRole("spinbutton", { name: /withdrawal amount/i }),
      { target: { value: "50" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: /withdraw to wallet/i }),
    );

    expect(await screen.findByText("200")).toBeTruthy();
    expect(runtime.withdraw).toHaveBeenCalledWith(
      50_000_000n,
      "0x7C26A0F7B7e9DfAA0D21e19b9E5D1D1D8bA84491",
      expect.any(Function),
    );
  });

  it("buys, sells, and returns proceeds from the same private position", async () => {
    const runtime = fixture();

    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));
    fireEvent.click(screen.getByRole("button", { name: /night market/i }));
    fireEvent.click(screen.getByRole("button", { name: /buy privately/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /sell this position/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /sell privately/i }));

    expect(await screen.findByText(/24\.2 USDC returned/i)).toBeTruthy();
    expect(runtime.buy).toHaveBeenCalledOnce();
    expect(runtime.sell).toHaveBeenCalledOnce();
    expect(runtime.readTokenBalance).toHaveBeenCalledOnce();
    expect(runtime.sell).toHaveBeenCalledWith(
      expect.objectContaining({ amountIn: 1_240_000n * 10n ** 18n }),
    );
    expect(runtime.returnToPool).toHaveBeenCalledOnce();
    const waitOrders = vi.mocked(runtime.waitForTransaction).mock
      .invocationCallOrder;
    expect(vi.mocked(runtime.buy).mock.invocationCallOrder[0]!).toBeLessThan(
      waitOrders[0]!,
    );
    expect(vi.mocked(runtime.sell).mock.invocationCallOrder[0]!).toBeLessThan(
      waitOrders[1]!,
    );
    expect(waitOrders[1]!).toBeLessThan(
      vi.mocked(runtime.returnToPool).mock.invocationCallOrder[0]!,
    );
    expect(
      localStorage.getItem(
        `privatepons-private-positions-v2:8453:0x${"aa".repeat(32)}`,
      ),
    ).toContain('"status":"closed"');
  });

  it("restores a held private position after a page refresh", async () => {
    const firstRuntime = fixture("live");
    vi.mocked(firstRuntime.readPrivateBalance).mockResolvedValue(25_000_000n);
    fireEvent.click(screen.getByRole("button", { name: /connect metamask/i }));
    await screen.findByRole("button", { name: /metamask connected/i });
    fireEvent.click(screen.getByRole("button", { name: /launch privately/i }));
    await screen.findByRole("button", { name: /sell creator position/i });

    cleanup();
    const secondRuntime = fixture("live");
    vi.mocked(secondRuntime.readPrivateBalance).mockResolvedValue(0n);
    fireEvent.click(screen.getByRole("button", { name: /connect metamask/i }));
    await screen.findByRole("button", { name: /metamask connected/i });
    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));
    fireEvent.click(screen.getByRole("button", { name: /positions/i }));

    expect(await screen.findByText("Night Market")).toBeTruthy();
    expect(await screen.findByText("Onchain verified")).toBeTruthy();
    expect(screen.getByText(/1,240,000/)).toBeTruthy();
    await waitFor(() => {
      expect(
        document.querySelector(".portfolio-position-metrics dd")?.textContent,
      ).toContain("24.2");
    });
    expect(screen.getByRole("button", { name: /sell position/i })).toBeTruthy();
    expect(secondRuntime.readAccountTokenBalance).toHaveBeenCalledWith(
      session.account,
      "0x4444444444444444444444444444444444444444",
    );
    expect(secondRuntime.quoteSell).toHaveBeenCalledWith(
      session.account,
      expect.objectContaining({
        token: "0x4444444444444444444444444444444444444444",
        amountIn: 1_240_000n * 10n ** 18n,
      }),
    );
  });
});
