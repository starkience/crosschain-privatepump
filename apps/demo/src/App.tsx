import { useMemo, useReducer, useState, type FormEvent } from "react";
import type {
  BridgeFundResult,
  BridgeReturnResult,
} from "@private-launchpad/sdk";
import {
  activeStages,
  flowReducer,
  initialFlowState,
  type FlowStage,
} from "./flow.js";
import type {
  LaunchDraft,
  LaunchpadRuntime,
  PreparedIdentity,
} from "./runtime.js";

interface AppProps {
  runtime: LaunchpadRuntime;
}

const stageRank: Record<FlowStage, number> = {
  draft: 0,
  identity: 1,
  bridging: 2,
  ready: 3,
  launching: 4,
  live: 5,
  returning: 6,
  returned: 7,
};

const route = [
  {
    stage: "identity" as const,
    index: "01",
    title: "Derive a private identity",
    detail: "An app-bound wallet signature stays in browser memory.",
  },
  {
    stage: "bridging" as const,
    index: "02",
    title: "Route a shielded note",
    detail: "STRK20 → CCTP → a fresh counterfactual Base account.",
  },
  {
    stage: "launching" as const,
    index: "03",
    title: "Execute the host calls",
    detail: "The same Clanker factory; a relayer pays the account gas.",
  },
  {
    stage: "returning" as const,
    index: "04",
    title: "Close the loop",
    detail: "Sell to USDC, burn through CCTP, mint a new private note.",
  },
];

const bridgeStepNames: Record<string, string> = {
  "select-private-note": "Selecting an eligible private note",
  "circle-burn": "Burning USDC for Circle CCTP",
  "base-mint": "Minting into the position account",
  "base-burn": "Burning return USDC on Base",
  "circle-attestation": "Waiting for Circle attestation",
  "mint-private-note": "Minting a fresh STRK20 note",
};

function shorten(value: string, head = 6, tail = 4): string {
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function usdc(value: bigint): string {
  return `${(Number(value) / 1_000_000).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })} USDC`;
}

function routeState(itemStage: FlowStage, currentStage: FlowStage) {
  const itemRank = stageRank[itemStage];
  const currentRank = stageRank[currentStage];
  if (itemRank === currentRank) return "active";
  if (itemRank < currentRank) return "done";
  return "waiting";
}

export function App({ runtime }: AppProps) {
  const [flow, dispatch] = useReducer(flowReducer, initialFlowState);
  const [executionMode, setExecutionMode] = useState<"private" | "public">(
    "private",
  );
  const [name, setName] = useState("Night Market");
  const [symbol, setSymbol] = useState("NITE");
  const [bridgeAmount, setBridgeAmount] = useState(25);
  const [creatorReward, setCreatorReward] = useState(40);
  const [identity, setIdentity] = useState<PreparedIdentity>();
  const [funding, setFunding] = useState<BridgeFundResult>();
  const [launchHash, setLaunchHash] = useState<string>();
  const [returned, setReturned] = useState<BridgeReturnResult>();
  const [bridgeStep, setBridgeStep] = useState<string>();
  const [publicNotice, setPublicNotice] = useState(false);

  const draft = useMemo<LaunchDraft>(
    () => ({
      name: name.trim(),
      symbol: symbol.trim().toUpperCase(),
      bridgeAmount: BigInt(Math.round(bridgeAmount * 1_000_000)),
      creatorReward,
    }),
    [bridgeAmount, creatorReward, name, symbol],
  );
  const valid =
    draft.name.length > 1 &&
    /^[A-Z0-9]{2,10}$/.test(draft.symbol) &&
    bridgeAmount >= 5;
  const busy = activeStages.has(flow.stage);

  const reportError = (error: unknown) => {
    dispatch({
      type: "FAIL",
      error:
        error instanceof Error ? error.message : "Unexpected runtime error",
    });
  };

  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    if (executionMode === "public") {
      setPublicNotice(true);
      return;
    }
    setPublicNotice(false);
    dispatch({ type: "PREPARE" });
    try {
      const nextIdentity = await runtime.prepareIdentity();
      setIdentity(nextIdentity);
      dispatch({ type: "IDENTITY_READY" });
      const nextFunding = await runtime.fund(draft, (step, status) => {
        if (status === "running") setBridgeStep(step);
      });
      setFunding(nextFunding);
      setBridgeStep(undefined);
      dispatch({ type: "FUNDED" });
    } catch (error) {
      reportError(error);
    }
  }

  async function launch() {
    if (flow.stage !== "ready") return;
    dispatch({ type: "LAUNCH" });
    try {
      setLaunchHash(await runtime.launch(draft));
      dispatch({ type: "LAUNCHED" });
    } catch (error) {
      reportError(error);
    }
  }

  async function returnFunds() {
    if (flow.stage !== "live") return;
    dispatch({ type: "RETURN" });
    try {
      const result = await runtime.returnToPool((step, status) => {
        if (status === "running") setBridgeStep(step);
      });
      setReturned(result);
      setBridgeStep(undefined);
      dispatch({ type: "RETURNED" });
    } catch (error) {
      reportError(error);
    }
  }

  function reset() {
    runtime.reset();
    dispatch({ type: "RESET" });
    setIdentity(undefined);
    setFunding(undefined);
    setLaunchHash(undefined);
    setReturned(undefined);
    setBridgeStep(undefined);
    setPublicNotice(false);
  }

  return (
    <div className="page-shell">
      <div className="grain" aria-hidden="true" />
      <header className="topbar">
        <a className="wordmark" href="#top" aria-label="Private Launchpad home">
          <span className="wordmark-mark">P//L</span>
          <span>
            PRIVATE
            <br />
            LAUNCHPAD
          </span>
        </a>
        <div className="network-strip" aria-label="Network status">
          <span className="network-dot" />
          Base Sepolia
          <span className="slash">/</span>
          STRK20
        </div>
        <div className="prototype-badge">
          <span>
            {runtime.mode === "demo" ? "Integration preview" : "Live runtime"}
          </span>
          <span className="badge-code">V0.1</span>
        </div>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="page-title">
          <div className="hero-copy">
            <p className="eyebrow">A private funding rail for public markets</p>
            <h1 id="page-title">
              Launch in public.
              <span>Arrive without a trail.</span>
            </h1>
            <p className="hero-deck">
              Attach STRK20 privacy to the launchpad you already operate. Keep
              the bonding curve, factory, and liquidity model. Replace the root
              wallet with a fresh account for every position.
            </p>
          </div>

          <div
            className="unlink-visual"
            aria-label="Root wallet unlinkability illustration"
          >
            <div className="root-node">
              <span>ROOT WALLET</span>
              <strong>0x7C26…4491</strong>
            </div>
            <div className="broken-link" aria-hidden="true">
              <span />
              <b>UNLINKED</b>
              <span />
            </div>
            <div className="account-node">
              <span>POSITION / 07</span>
              <strong>0x8A4d…5A02</strong>
              <i>public on Base</i>
            </div>
          </div>
        </section>

        <section
          className="launch-workspace"
          aria-label="Private launch integration preview"
        >
          <div className="workspace-heading">
            <div>
              <p className="section-index">01 / HOST INTERFACE</p>
              <h2>The launch form barely changes.</h2>
            </div>
            <p>
              This panel represents an existing launchpad. The privacy plugin
              only changes who funds and signs the calls.
            </p>
          </div>

          <div className="workspace-grid">
            <form className="launch-form" onSubmit={prepare}>
              <div
                className="mode-switch"
                role="group"
                aria-label="Execution mode"
              >
                <button
                  type="button"
                  className={executionMode === "public" ? "selected" : ""}
                  aria-pressed={executionMode === "public"}
                  onClick={() => setExecutionMode("public")}
                >
                  Public
                </button>
                <button
                  type="button"
                  className={executionMode === "private" ? "selected" : ""}
                  aria-pressed={executionMode === "private"}
                  onClick={() => setExecutionMode("private")}
                >
                  Private <span>STRK20</span>
                </button>
              </div>

              <div className="field-pair">
                <label>
                  <span>Token name</span>
                  <input
                    value={name}
                    maxLength={40}
                    disabled={busy || flow.stage !== "draft"}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label>
                  <span>Ticker</span>
                  <div className="ticker-input">
                    <b>$</b>
                    <input
                      value={symbol}
                      maxLength={10}
                      disabled={busy || flow.stage !== "draft"}
                      aria-describedby="ticker-rule"
                      onChange={(event) =>
                        setSymbol(event.target.value.toUpperCase())
                      }
                    />
                  </div>
                  <small id="ticker-rule">2–10 letters or numbers</small>
                </label>
              </div>

              <div className="token-preview">
                <div className="token-orbit" aria-hidden="true">
                  <span>{draft.symbol.slice(0, 1) || "?"}</span>
                </div>
                <div>
                  <span>Launch preview</span>
                  <strong>{draft.name || "Unnamed token"}</strong>
                  <small>${draft.symbol || "—"} · Clanker v3.1</small>
                </div>
                <div className="factory-tag">
                  <span>FACTORY</span>
                  0x2A78…7382
                </div>
              </div>

              <fieldset
                className="denominations"
                disabled={busy || flow.stage !== "draft"}
              >
                <legend>Private position budget</legend>
                <p>Common denominations preserve a larger anonymity set.</p>
                <div>
                  {[5, 10, 25, 50].map((amount) => (
                    <button
                      type="button"
                      key={amount}
                      className={bridgeAmount === amount ? "selected" : ""}
                      aria-pressed={bridgeAmount === amount}
                      onClick={() => setBridgeAmount(amount)}
                    >
                      {amount} <span>USDC</span>
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className="reward-field">
                <span>
                  Creator reward <b>{creatorReward}%</b>
                </span>
                <input
                  type="range"
                  min="0"
                  max="80"
                  step="5"
                  value={creatorReward}
                  disabled={busy || flow.stage !== "draft"}
                  onChange={(event) =>
                    setCreatorReward(Number(event.target.value))
                  }
                />
                <small>
                  Creator admin and rewards resolve to the position account.
                </small>
              </label>

              <div className="execution-facts">
                <div>
                  <span>Initial buy</span>
                  <strong>0 ETH</strong>
                </div>
                <div>
                  <span>Gas payer</span>
                  <strong>Relayer</strong>
                </div>
                <div>
                  <span>Venue</span>
                  <strong>Unchanged</strong>
                </div>
              </div>

              {publicNotice && (
                <div className="form-notice" role="status">
                  Public mode belongs to the host’s existing submit handler.
                  Switch to Private to preview the plugin path.
                </div>
              )}
              {flow.error && (
                <div className="form-error" role="alert">
                  <span>{flow.error}</span>
                  <button type="button" onClick={reset}>
                    Reset flow
                  </button>
                </div>
              )}

              <button
                className="primary-action"
                type="submit"
                disabled={!valid || busy || flow.stage !== "draft"}
              >
                <span>
                  {executionMode === "private"
                    ? busy
                      ? "Preparing route"
                      : "Prepare private launch"
                    : "Continue with host wallet"}
                </span>
                <b aria-hidden="true">↗</b>
              </button>
            </form>

            <aside className="privacy-rail" aria-live="polite">
              <div className="rail-header">
                <div>
                  <p className="section-index">02 / PRIVACY RAIL</p>
                  <h3>One position. One address.</h3>
                </div>
                <span className={`runtime-status ${runtime.mode}`}>
                  {runtime.mode === "demo" ? "SIMULATION" : "LIVE"}
                </span>
              </div>

              <div className="route-list">
                {route.map((item) => {
                  const state = routeState(item.stage, flow.stage);
                  return (
                    <div className={`route-item ${state}`} key={item.index}>
                      <span className="route-index">
                        {state === "done" ? "✓" : item.index}
                      </span>
                      <div>
                        <strong>{item.title}</strong>
                        <p>{item.detail}</p>
                      </div>
                      <span className="route-state">
                        {state === "done"
                          ? "DONE"
                          : state === "active"
                            ? "NOW"
                            : "WAIT"}
                      </span>
                    </div>
                  );
                })}
              </div>

              {bridgeStep && (
                <div className="bridge-progress" role="status">
                  <span className="progress-pulse" />
                  <div>
                    <small>Bridge engine</small>
                    <strong>{bridgeStepNames[bridgeStep] ?? bridgeStep}</strong>
                  </div>
                </div>
              )}

              <div className="session-card">
                <div className="session-topline">
                  <span>COUNTERFACTUAL ACCOUNT</span>
                  <i>{identity ? "DERIVED" : "NOT CREATED"}</i>
                </div>
                <strong>
                  {identity
                    ? shorten(identity.session.account, 10, 8)
                    : "0x — — — — — — — —"}
                </strong>
                <div className="session-grid">
                  <span>
                    Index <b>{identity?.session.accountIndex ?? "—"}</b>
                  </span>
                  <span>
                    CCTP <b>{funding ? "minted" : "waiting"}</b>
                  </span>
                  <span>
                    Root link <b>not published</b>
                  </span>
                  <span>
                    Budget <b>{bridgeAmount} USDC</b>
                  </span>
                </div>
              </div>

              {flow.stage === "ready" && (
                <button className="rail-action" type="button" onClick={launch}>
                  Relay launch to Clanker <span>↗</span>
                </button>
              )}
              {flow.stage === "launching" && (
                <button className="rail-action loading" type="button" disabled>
                  Simulating + broadcasting <span>•••</span>
                </button>
              )}
              {flow.stage === "live" && (
                <button
                  className="rail-action inverse"
                  type="button"
                  onClick={returnFunds}
                >
                  Simulate sell + return <span>↙</span>
                </button>
              )}
              {flow.stage === "returning" && (
                <button
                  className="rail-action loading inverse"
                  type="button"
                  disabled
                >
                  Returning through CCTP <span>•••</span>
                </button>
              )}
              {flow.stage === "returned" && (
                <button
                  className="rail-action success"
                  type="button"
                  onClick={reset}
                >
                  Route complete — reset <span>✓</span>
                </button>
              )}

              <p className="simulation-note">
                {runtime.mode === "demo"
                  ? "Preview only — generated addresses and transaction hashes are clearly simulated. No wallet is contacted."
                  : "Live runtime — wallet prompts and transaction state come from the injected host integration."}
              </p>
            </aside>
          </div>
        </section>

        {(launchHash || returned) && (
          <section className="position-receipt" aria-label="Position receipt">
            <div>
              <p className="section-index">03 / POSITION RECEIPT</p>
              <h2>{draft.name}</h2>
              <span className="live-pill">
                {returned ? "RETURNED" : "LIVE"}
              </span>
            </div>
            <dl>
              <div>
                <dt>Public position</dt>
                <dd>{identity && shorten(identity.session.account, 10, 8)}</dd>
              </div>
              <div>
                <dt>Host transaction</dt>
                <dd>{launchHash && shorten(launchHash, 10, 8)}</dd>
              </div>
              <div>
                <dt>Private funding</dt>
                <dd>{funding ? `${bridgeAmount} USDC delivered` : "—"}</dd>
              </div>
              <div>
                <dt>Return</dt>
                <dd>
                  {returned
                    ? `${usdc(returned.amountReturned)} in a new note`
                    : "Open position"}
                </dd>
              </div>
            </dl>
          </section>
        )}

        <section
          className="privacy-ledger"
          aria-labelledby="privacy-ledger-title"
        >
          <div className="ledger-intro">
            <p className="section-index">04 / HONEST PRIVACY</p>
            <h2 id="privacy-ledger-title">Private does not mean invisible.</h2>
            <p>
              STRK20 hides the relationship that matters. Base still executes a
              normal launch in public, preserving composability and market
              integrity.
            </p>
          </div>
          <div className="ledger-column hidden-column">
            <span className="ledger-label">HIDDEN</span>
            <ul>
              <li>Root wallet ↔ position account</li>
              <li>Note ownership and private transfers</li>
              <li>Which notes funded the withdrawal</li>
              <li>Unrelated positions from the same user</li>
            </ul>
          </div>
          <div className="ledger-column public-column">
            <span className="ledger-label">PUBLIC</span>
            <ul>
              <li>The EVM position account</li>
              <li>Token, venue, calldata, and trade amount</li>
              <li>Deposit and withdrawal edges</li>
              <li>Timing and distinctive denominations</li>
            </ul>
          </div>
        </section>

        <section className="adoption-strip">
          <div>
            <p className="section-index">FOR LAUNCHPAD TEAMS</p>
            <h2>Three seams. Zero market migration.</h2>
          </div>
          <ol>
            <li>
              <b>01</b>
              <span>Wrap your existing prepared calls in a host adapter.</span>
            </li>
            <li>
              <b>02</b>
              <span>
                Inject the official bridge package into the browser runtime.
              </span>
            </li>
            <li>
              <b>03</b>
              <span>
                Run the policy relayer and deploy one account factory.
              </span>
            </li>
          </ol>
        </section>
      </main>

      <footer>
        <span>PRIVATE LAUNCHPAD / REFERENCE INTEGRATION</span>
        <span>STRK20 × CCTP × EXISTING EVM VENUES</span>
        <a href="https://github.com/starkience/crosschain-privatepump">
          SOURCE ↗
        </a>
      </footer>
    </div>
  );
}
