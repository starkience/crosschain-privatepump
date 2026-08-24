# Crosschain Private Launchpad

A privacy plugin for existing EVM token launchpads. It combines STRK20's Starknet privacy pool,
StarkWare's CCTP privacy bridge, deterministic EVM execution accounts, and small host adapters. It
does **not** deploy a new launchpad, bonding curve, or AMM.

The user shields USDC into STRK20, privately selects a note, and bridges a fixed amount to a fresh
counterfactual account on Base. A relayer submits owner-signed calls from that account to the host
launchpad. After a sale or claim, residual USDC can return through CCTP into a new STRK20 note.

## What is private

- The connected/root wallet is not revealed to the host launchpad.
- Ownership, balance, token, amount, and note-to-note transfers inside STRK20 are encrypted.
- One execution account per position prevents unrelated launches/trades from sharing an address.

The EVM account, token, venue, calldata, trade amount, bridge amount, and timing are public. Pool
deposits and withdrawals are public edges. This product provides root-wallet unlinkability, not
confidential EVM execution. See [the privacy model](docs/privacy-model.md) before using the word
"private" in product copy.

## Architecture

| Component                        | Responsibility                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| STRK20                           | Shielded USDC notes, private transfers, proofs, deposit screening, selective disclosure |
| Starknet privacy bridge          | CCTP USDC into/out of the pool; canonical outbound and inbound anonymizers              |
| `PrivateLaunchpadAccountFactory` | CREATE2 address prediction and counterfactual account deployment                        |
| `PrivateLaunchpadAccount`        | EIP-712 owner-authorized, relayed call batches against an unchanged host                |
| `@private-launchpad/sdk`         | Bridge orchestration, account derivation, host adapter calls, return-to-pool            |
| Relayer                          | Pays EVM gas and submits signed batches; may collect a signer-approved USDC fee         |
| Host adapter                     | Converts the host's existing quote/launch/buy/sell result into execution calls          |

Read [architecture](docs/architecture.md), [launchpad and liquidity flows](docs/launchpad-liquidity.md),
and the [integration guide](docs/integration.md).

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

Run `pnpm --filter @private-launchpad/demo dev` to open the reference integration frontend. Its
default simulation mode never contacts a wallet and never presents sample bridge activity as a real
transaction. Launchpad teams replace that runtime with the included `createLiveRuntime` binding to
their configured SDK client and host adapter.

The official privacy-bridge package is currently served from GitHub Packages and requires a GitHub
token with `read:packages`. It is injected into the SDK at application startup, so this repository
can build without registry credentials and never forks bridge cryptography.

## Sepolia

Base Sepolia is the first EVM target (`chainId 84532`, CCTP domain `6`). The official STRK20 pool
and privacy-bridge anonymizers already exist on Starknet Sepolia; this repository only needs to
deploy the EVM account factory and a relayer. See [deployment](docs/deployment.md) for addresses,
commands, verification gates, and the credentials still required.

## Security status

Prototype, unaudited. The account contract is intentionally non-upgradeable and uses strict nonce,
deadline, fee, prefund, chain, and verifying-contract binding. Do not deploy on mainnet until the
account, relayer policy, client secret handling, bridge version, and host adapter have independent
security review.

See [SECURITY.md](SECURITY.md) for reporting and deployment guidance.
