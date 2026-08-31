# Architecture

## Design objective

Add a private mode to an existing EVM launchpad without asking that launchpad to migrate chains or
replace its contracts. The host remains the source of truth for token creation, sale phase, pricing,
slippage, migration/graduation, liquidity, and rewards. Privacy is an execution and funding layer.

## End-to-end flow

The numbered flow below is the generic direct-CCTP path used by CCTP-native EVM hosts. PrivatePons
uses the same account and authorization model but composes Relay around CCTP because Robinhood is
not a Circle domain:

```text
Robinhood USDG ↔ Relay ↔ Arbitrum USDC ↔ Circle CCTP ↔ STRK20
```

For the Pons-specific deposit, funding, and S2 return flows, see `private-pons-relay.md`.

1. The connected EVM wallet signs one app-bound, versioned identity message. The signature stays in
   memory. StarkWare's bridge derives a Starknet account key, STRK20 viewing key, and a domain-
   separated EVM owner key.
2. `moveIntoPool` sends EVM USDC through Circle CCTP and deposits it into STRK20. The deposit address,
   token, amount, and time are public and screened. Note ownership and later pool movement are
   private.
3. For every launch or position, the SDK selects a new account index. The derived EVM owner and
   factory produce a CREATE2 execution-account address. The account need not exist yet.
4. `fundAccountFromPool` withdraws a chosen USDC denomination to the canonical outbound anonymizer.
   It burns through CCTP and Circle mints to the counterfactual account on the selected EVM chain.
5. The host adapter asks the launchpad's own SDK/API for its normal call plan. The derived owner signs
   an EIP-712 batch binding calls, account, chain, nonce, deadline, prefund, and relayer fee.
6. A relayer calls `deployAndExecute`. The factory deploys the account on first use, and the account
   calls the unchanged launchpad. The host sees the private execution account as creator/trader.
7. Assets and claims remain in that per-position account. The same mechanism approves and sells the
   token or claims host rewards.
8. Once proceeds are native USDC, StarkWare's return flow builds the Circle burn calls. The account
   signs and relays them. On Starknet, the inbound anonymizer's `privacy_compute` binds the attested
   CCTP message to the authenticated pool identity and atomically mints into a new open note.
9. When the user withdraws from Private Balance, `cashOut` burns a selected private amount and
   resumes Circle attestation/mint to the chosen public EVM destination if the page is interrupted.

## Why a deterministic smart account

CCTP mints USDC, not native EVM gas. A bare derived EOA cannot make its first approval, trade, or
return transaction unless someone sends it ETH, which adds linkage and operational friction. The
account allows an unrelated relayer to pay gas while the derived owner retains authorization.
Counterfactual deployment lets Circle mint to the final account address before code exists.

The account supports arbitrary `CALL` batches, ERC-1271 signatures, and ERC-721/ERC-1155 receipt. It
is deliberately non-upgradeable, has no admin, and cannot delegatecall. Every position should use a
new account index because all activity from one account is publicly linkable.

## Boundaries

- `@private-launchpad/sdk` owns account derivation, bridge orchestration, signed execution, and
  return-to-pool.
- The bridge engine is injected from `@starkware-libs/starknet-privacy-bridge`; this project does not
  copy its key derivation, proof, discovery, CCTP parsing, or Cairo contracts.
- The Clanker adapter uses the official V4 SDK. On mainnet, the trade adapter uses Uniswap's API
  through a same-origin route. On Base Sepolia, the server reads Clanker's PoolKey, uses Uniswap's
  deployed V4Quoter, and targets the narrowly scoped Plank swap helper.
- The relayer verifies static policy and the owner signature, simulates, then broadcasts. It cannot
  change signed calls or fees.

## Compatibility constraints

The generic path works when the host accepts contract callers and lets the account receive the
resulting ERC-20/ERC-721/ERC-1155 assets. An adapter must reject integrations that use `tx.origin`,
require an EOA-only offchain identity, send assets to an unrelated hard-coded recipient, or bind a
server session to the connected root wallet.

USDC-quoted launchpads are the simplest. ETH-quoted hosts require an additional signed USDC-to-ETH
swap call (or relayer prefund) before the host call. That swap and the resulting amount remain
public. Cross-chain memecoins themselves are not STRK20 notes: sell/convert them back to native USDC
before returning value to the pool.
