# PrivatePons

A Pons-first private launch and trading app on Robinhood Chain. It combines STRK20's Starknet privacy pool,
StarkWare's CCTP privacy bridge, deterministic EVM execution accounts, and small host adapters. It
does **not** deploy a new launchpad, bonding curve, or AMM.

The user deposits Robinhood USDG, Relay moves it through a domain-separated Arbitrum account, and
the official StarkWare bridge shields native USDC into STRK20. Private funding follows Fast CCTP
back to Arbitrum, then Relay delivers USDG to a fresh counterfactual Robinhood account. A relayer
submits owner-signed Pons calls from that account.

## What is private

- The connected/root wallet is not linked **onchain** to the host launchpad execution account when
  the prescribed route is followed.
- Ownership, balance, token, amount, and note-to-note transfers inside STRK20 are encrypted.
- One execution account per position prevents unrelated launches/trades from sharing an address.

The EVM account, token, venue, calldata, trade amount, bridge amount, and timing are public. Pool
deposits and withdrawals are public edges. This product provides root-wallet unlinkability, not
confidential EVM execution. Relay sees both endpoints of each Relay order; Circle sees CCTP
transfers; and this app's browser storage and infrastructure can correlate a connected wallet with
its position accounts. See [the privacy model](docs/privacy-model.md) before using the word
"private" in product copy.

## Product flow

1. **Deposit:** the connected Robinhood wallet transfers USDG through Relay and CCTP into
   **Private Balance**. This bridge edge is public.
2. **Launch + initial buy:** a fresh Robinhood account receives a private-balance budget as USDG,
   launches through the canonical Pons V2 factory, then buys on the Pons bonding curve.
3. **Buy:** each private position funds a different counterfactual account and buys from the live
   Pons curve. The token remains in that account.
4. **Sell:** the same account sells, Relay returns proceeds through an isolated S2 identity, and an
   internal STRK20 transfer merges the note into the user's main private balance.
5. **Withdraw:** the user can cash out Private Balance to any EVM address. The destination, amount,
   and time are public; the source note remains hidden.

`apps/demo` implements this full product UX and boots the live PrivatePons runtime. Startup fails
closed when the required same-origin RPC, Relay, bridge, paymaster, or policy-relayer infrastructure
is unavailable; it does not silently fall back to simulated activity.

## Architecture

| Component                        | Responsibility                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| STRK20                           | Shielded USDC notes, private transfers, proofs, deposit screening, selective disclosure  |
| Starknet privacy bridge          | CCTP USDC into/out of the pool; canonical outbound and inbound anonymizers               |
| `PrivateLaunchpadAccountFactory` | CREATE2 address prediction and counterfactual account deployment                         |
| `PrivateLaunchpadAccount`        | EIP-712 owner-authorized, relayed call batches against an unchanged host                 |
| `@private-launchpad/sdk`         | Bridge orchestration, account derivation, host adapter calls, return-to-pool             |
| Relayer                          | Pays EVM gas and submits signed batches; may collect a signer-approved USDC fee          |
| Pons V2 adapter                  | Builds launch/buy/sell calls and binds creator/trade recipients to the fresh account     |
| Relay bridge client              | Validates strict USDC/USDG deposit routes, output minimums, status, and recovery cursors |

Read [architecture](docs/architecture.md), [launchpad and liquidity flows](docs/launchpad-liquidity.md),
the [integration guide](docs/integration.md), and the [Vercel mainnet deployment runbook](docs/vercel-mainnet.md).

## Repository

```text
evm/                 deterministic execution account + Foundry tests/deploy script
packages/sdk/        framework-agnostic plugin SDK
packages/relayer/    minimal policy-enforcing EVM relayer
apps/demo/            reference launchpad UI with explicit simulation/live runtime boundary
docs/                architecture, privacy, launchpad research, deployment
```

The predecessor PrivatePump codebase was studied as a launchpad-flow reference, but it is not copied
into this clean plugin repository.

## Develop

Requirements: Node 24+, pnpm 10+, Foundry.

```sh
pnpm install
pnpm setup:evm
pnpm typecheck
pnpm test
pnpm build
```

Run `pnpm --filter @private-launchpad/demo dev` to open PrivatePons. The checked-in entry point uses
`createPrivatePonsLiveRuntime`; configure the server-side upstreams in `.env.local` before starting
it. Tests inject preview runtimes explicitly and never present them as live activity.

The official privacy-bridge package is currently served from GitHub Packages and requires a GitHub
token with `read:packages`. It is injected into the SDK at application startup, so this repository
can build without registry credentials and never forks bridge cryptography. When package access is
unavailable, `pnpm build:official-bridge` builds an ignored, integrity-checked browser artifact from
exact official commits and records its provenance.

## Sepolia

Base Sepolia is the first EVM target (`chainId 84532`, CCTP domain `6`). The official STRK20 pool
and privacy-bridge anonymizers already exist on Starknet Sepolia; this repository only needs to
deploy the EVM account factory, testnet V4 helper, and a relayer. See [deployment](docs/deployment.md) for addresses,
commands, verification gates, and the credentials still required.

## Robinhood Chain + Pons

The chain-`4663` Pons V2 execution path supports USDG launches and pre-graduation trades. It
uses the same counterfactual execution account and relayer authorization model as Base, while the
adapter and relayer enforce Pons-specific factory, curve, token, recipient, phase, value, and live
economics constraints. A Robinhood mainnet-fork launch → buy → sell proof passes against the live
Pons stack.

The mainnet MVP transport is implemented as STRK20/Circle Fast CCTP ↔ Arbitrum USDC ↔ Relay ↔
Robinhood USDG. The browser validates Relay's strict deposit transaction before every irreversible
burn and persists the private-funding request so it resumes rather than double-burning. For sell
returns, the same-origin proxy signs a short-lived binding for Relay's exact quote, and the policy
relayer verifies the request ID, strict deposit address, amount, refund owner, and isolated recipient
before broadcast. A small mainnet
canary remains mandatory before enabling general use. See the [Relay architecture](docs/private-pons-relay.md), [assessment](docs/robinhood-pons-assessment.md),
[architecture](docs/robinhood-pons-architecture.md), [transport analysis](docs/bridge-transport-analysis.md),
and [phased plan](docs/robinhood-pons-implementation-plan.md).

## Security status

Prototype, unaudited. The account contract is intentionally non-upgradeable and uses strict nonce,
deadline, fee, prefund, chain, and verifying-contract binding. Do not deploy on mainnet until the
account, relayer policy, client secret handling, bridge version, and host adapter have independent
security review.

See [SECURITY.md](SECURITY.md) for reporting and deployment guidance.
