# Robinhood + Pons phased implementation plan

The phases are gated. A later phase does not begin merely because its code can be written.

Status update (2026-08-31): the earlier LayerSwap/Rhino investigation is superseded. The implemented
route uses Relay for Robinhood ↔ Arbitrum and Circle CCTP V2 for Arbitrum ↔ Starknet. Historical
provider evaluation remains documented in `bridge-transport-analysis.md`; it is not the deployment
plan.

## Phase 0 — research and decision record

Deliverables:

- [Robinhood/Pons assessment](robinhood-pons-assessment.md)
- [Robinhood/Pons architecture](robinhood-pons-architecture.md)
- [bridge transport analysis](bridge-transport-analysis.md)
- versioned live deployment manifest and source/commit snapshot

Exit gate: reviewers agree on the privacy statement, current Pons V2 target, USDG asset, the
Relay + CCTP composition, and the fact that it provides onchain root-wallet separation rather than
perfect anonymity.

## Phase 1 — execution path, no bridge

Build:

1. Robinhood mainnet/testnet chain definitions and a current Pons V2 deployment manifest.
2. Pons V2 ABIs and a typed adapter for launch, pre-graduation buy, and pre-graduation sell.
3. Live-state guards for launch gate/fee/config/USDG economics digest and token phase.
4. Exact approvals, explicit account recipients, bounded metadata/taxes, nonzero min outputs, and
   deterministic caller-provided salt.
5. Pons semantic relayer policy for factory, dynamic curve/token, USDG, recipients, values, and
   selectors.
6. Event-based launch discovery that coexists with ordinary Pons interfaces.

Tests:

- adapter encoding and malicious-input rejection;
- quote math against Pons vectors and boundary rounding;
- relayer rejection of wrong factory, curve, token, recipient, pair asset, approval spender, phase,
  native value, slippage, and economics digest;
- unchanged Base/Clanker SDK, relayer, and Foundry suites; and
- Robinhood mainnet-fork account deploy → Pons USDG launch → buy → sell, verifying creator and asset
  custody at the execution account.

Status: implemented and verified on a Robinhood mainnet fork on 2026-08-26. The account deployed
counterfactually, launched a live Pons V2 USDG curve, bought, and sold while retaining custody and
creator/deployer attribution. The full Base regression suite remains a required release check.

Exit gate: the fork flow passes against the current live Pons stack and no Base behavior changes.

## Phase 2 — graduated Pons markets

Build a Pons-aware Uniswap V4 adapter. Resolve phase and pool key from the token's factory stack,
require the documented meme hook, bind token/USDG direction, obtain a quote, and validate the
prepared route semantically. Keep the pre-graduation curve adapter separate.

Exit gate: fork tests buy and sell a phase-`2` token; phase `1` and `3` fail closed; arbitrary hooks,
pools, universal-router commands, Permit2 approvals, and recipients are rejected.

## Phase 3 — Relay route proof

Implemented route:

1. Relay quotes Arbitrum native USDC ↔ Robinhood USDG using strict deposit addresses.
2. The client validates chain IDs, token addresses, sender, exact input, ERC-20 transfer calldata,
   output minimum, and request ID.
3. A live read-only quote check confirms both directions are currently available.
4. Funding cursors persist the CCTP burn and Relay request before status polling.

Remaining exit gate: execute minimum-size mainnet transfers in both directions and verify gas top-up,
quote expiry, duplicate recovery, partial/failed settlement, and refunds. Route-list or quote
availability alone is not a funded canary.

## Phase 4 — STRK20/CCTP composition

Implemented:

- the pinned official StarkWare privacy bridge and canonical mainnet anonymizers;
- Circle Fast CCTP between Starknet domain `25` and Arbitrum domain `3`;
- Relay transport adapters for deposit, private funding, and sell return;
- a position-specific A2/S2 return identity followed by a private S2 → S1 transfer; and
- UI progress and recovery state for the composed route.

Remaining security work:

- independent Cairo/Solidity/TypeScript review;
- crash recovery for deposit and sell-return before the downstream CCTP cursor exists;
- rejection of arbitrary calls and approvals;
- memory-only identities and keys;
- provider credential isolation on the server; and
- disclosure that Relay, Circle, browser storage, and app infrastructure can correlate edges.

Completed hardening: sell returns now fail closed unless the policy relayer verifies the trusted
quote proxy's short-lived MAC binding for the request ID, R2 user, refund owner, isolated recipient,
strict deposit address, and amount. Browser recovery namespaces are derived from the identity
signature rather than R1, and legacy R1-keyed records are migrated and deleted.

Exit gate: adversarial tests, independent review, and an end-to-end small-value launch/buy/sell/
return exercise complete without root-wallet funding or gas.

## Phase 5 — product hardening

- relayer redundancy, rate limits, per-account spend/prefund caps, and abuse controls;
- provider webhooks plus independent chain reconciliation;
- versioned deployment/bytecode checks and emergency route disablement;
- operation export/support tooling without secret material;
- privacy copy review and analytics audit;
- audit of the execution account, relayer policies, Pons adapters, and transport helpers; and
- monitoring for Pons factory/config/phase, USDG controls, provider route, and API changes.

Exit gate: security sign-off and a runbook covering provider outage, Pons stack replacement, USDG
pause/restriction, relayer compromise, stuck return, and refund/manual review.

## Explicit non-goals

- no new launchpad, bonding curve, or liquidity fork;
- no claim that Robinhood execution amounts or calls are confidential;
- no bridge implementation before the Phase 1 smart-account proof;
- no copying StarkWare key derivation, proofs, or note discovery;
- no generic arbitrary-call anonymizer or relayer mode;
- no reuse of Base CCTP configuration for a chain Circle does not support; and
- no automatic migration of a Pons launch between curve and V4 without phase verification.
