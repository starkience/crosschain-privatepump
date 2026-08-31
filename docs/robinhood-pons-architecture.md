# Robinhood + Pons architecture

## Objective

Reuse the Base private-launchpad core on Robinhood Chain without changing Pons or weakening the
existing Base/CCTP path. Chain transport and launchpad behavior remain adapters around one
deterministic execution-account protocol.

## Component boundaries

| Component             | Owns                                                             | Must not own                           |
| --------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| STRK20                | shielded USDC notes, authenticated note identity, proofs         | Robinhood routing or Pons semantics    |
| Privacy bridge engine | key derivation and chain-specific fund/return orchestration      | launchpad calldata                     |
| Transport adapter     | quote/order, destination/refund binding, status/recovery         | identity derivation or Pons pricing    |
| Execution account     | owner-authorized calls, asset custody, relayer fee, nonce        | quote discovery or mutable admin logic |
| Pons adapter          | live factory/curve reads, exact calldata, phase routing          | bridge orders or owner key handling    |
| Relayer               | semantic policy, simulation, broadcast, optional bounded prefund | call mutation or user-secret custody   |
| Indexer/UI            | Pons event discovery, lifecycle, resumable operation journal     | authority over contract state          |

The existing `PrivacyBridgeEngine` interface remains the seam. The official
`@starkware-libs/starknet-privacy-bridge` engine owns the Starknet ↔ Arbitrum CCTP legs. A separate
Relay transport owns Arbitrum USDC ↔ Robinhood USDG; Robinhood itself is not configured as a CCTP
domain.

## Identities and accounts

One app-bound identity signature derives independent secrets with versioned labels:

- Starknet account key;
- STRK20 viewing key; and
- EVM execution owner key, separated by account index and channel.

The raw signature and all derived private keys are memory-only. Each Pons launch or trade position
uses a new account index. The existing factory computes:

```text
owner = deriveEvmOwner(identitySignature, accountIndex, channel)
account = CREATE2(factory, owner, accountIndex)
```

The account address is final before deployment. A bridge provider may deliver USDG to it while it
has no code. The first relayed `deployAndExecute` deploys the account and executes the signed batch.

Do not reuse an account across unrelated positions. Everything performed by a single Robinhood
address is public and linkable even though its owner is not the connected wallet.

## Funding flow: private USDC to Pons USDG

1. The user chooses a private USDC note/budget and a new account index.
2. The client derives the counterfactual Robinhood execution account.
3. Relay quotes Arbitrum USDC → Robinhood USDG for R2 and returns a strict Arbitrum deposit address,
   output minimum, refund address, and durable request ID.
4. The official bridge quotes Circle Fast CCTP for Starknet domain `25` → Arbitrum domain `3`.
5. STRK20 proves a withdrawal through the canonical outbound anonymizer and burns native USDC to
   Relay's exact Arbitrum deposit address.
6. Circle's forwarding service mints on Arbitrum; Relay observes the deposit and sends USDG to R2.
7. The client persists the CCTP burn/Relay request cursor and checks Relay terminal status plus the
   resulting Robinhood account balance before executing Pons calls.
8. If this is a launch, the owner signs a Pons batch. The relayer supplies the exact, signed Pons
   launch fee in ETH as account prefund; the account pays the factory and may repay a bounded USDG
   relayer fee.

The CCTP and Relay legs are not atomic. Circle sees the CCTP message, Relay sees both endpoints of
its order, and amount/timing can correlate the public edges. The route needs its own recovery model
and product disclosure.

## Pons execution flows

### Launch

Before encoding calls, read and bind:

- current factory manifest and bytecode;
- `canLaunch(account)`;
- `launchFee()`;
- `getLaunchConfig(id)`;
- `approvedPairTokens(USDG)` and `pairTokenEconomics(USDG)`; and
- `previewLaunchEconomics(id, USDG)`.

Use the digest as `TokenParams.expectedEconomics`, the account as explicit creator fee recipient,
and a caller-provided random salt. The account batch contains one payable call to the factory. The
signed `prefund` equals the native value the account lacks, capped by relayer policy.

### Buy before graduation

1. Resolve `getLaunchedToken(token)` from the correct factory stack.
2. Require `exists`, `phase == NotGraduated`, `pairToken == USDG`, and the expected curve.
3. Read curve state and reproduce the official integer math, including base fee, creator tax, and
   current decaying snipe tax.
4. Build exact USDG approval to the curve.
5. Build `buy(quoteIn, minTokensOut, account)` with zero native value.
6. Sign, semantically validate, simulate, and relay the two-call batch.

### Sell before graduation

Require the same record and phase, approve the exact token amount to the curve, then call
`sell(tokensIn, minQuoteOut, account)`. Verify the actual USDG balance delta after receipt.

### Graduated market

For `phase == PoolCreated`, resolve the pool key from the launch record and route through a separate
Uniswap V4 adapter constrained to the expected Pons hook. The curve call is invalid after
graduation. `Swept` and `Rescued` fail closed until explicit recovery behavior exists.

## Return flow: Pons USDG to private USDC

1. Sell/route the launch token to USDG in the same execution account.
2. Derive a position-specific A2 Arbitrum account and a distinct S2 STRK20 identity.
3. Quote Relay for Robinhood USDG → Arbitrum USDC, with A2 as recipient and the position owner O2 as
   refund address.
4. R2 signs one exact USDG transfer from Relay's strict deposit transaction. The policy relayer
   validates a positive, zero-native-value USDG transfer and broadcasts it.
5. Relay sends native USDC plus the configured gas top-up to A2.
6. A2 burns through CCTP into S2 using the official inbound anonymizer flow.
7. S2 privately transfers the resulting note inside STRK20 to the main S1 identity.

The client validates the quote's chain, token, sender, amount, and exact ERC-20 transfer calldata.
It includes the Relay request ID as policy metadata beside the owner-signed batch. Before broadcast,
the relayer resolves that ID through Relay's authenticated Requests API and independently binds the
R2 user, refund owner, strict deposit address, Robinhood USDG input, exact amount, Arbitrum USDC
output, executable status, and maximum quote age. This avoids a process-local cache that would be
unsafe across serverless instances.

## Operation state machine

```text
quoted
  -> order_persisted
  -> source_submitted
  -> source_confirmed
  -> provider_processing
  -> destination_delivered
  -> destination_verified
  -> note_opened          (return only)

quoted/order_persisted -> expired
source_submitted/...    -> refund_pending -> refunded
any non-terminal state  -> manual_review
```

Status must be derived from provider state plus independent chain reads. Timeouts are not failures.
Never create a second order or resubmit a deposit merely because polling was interrupted.

## Relayer policy

Static allowed addresses are insufficient because every Pons launch creates a new curve and token.
The Robinhood policy must decode calls and validate their relationships:

| Call                  | Semantic policy                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pons launch           | current factory only; supported selector; USDG pair; account recipient; digest nonzero; bounded metadata/tax; exact launch value                                             |
| USDG approval         | exact amount; spender is validated curve or validated transport depository                                                                                                   |
| Launch-token approval | target equals token from factory record; spender equals its recorded curve or approved V4 router                                                                             |
| Curve buy/sell        | curve equals factory record; explicit recipient equals account; phase is `0`; signed min output is nonzero                                                                   |
| V4 trade              | route/pool/hook/token pair exactly matches phase-`2` record; deadline and slippage bounded                                                                                   |
| Relay return transfer | one positive USDG transfer, zero native value/prefund, plus authenticated request-ID binding to R2, refund owner, strict deposit address, route, exact amount, and quote age |

The relayer still independently checks account derivation, EIP-712 signature, nonce, deadline,
prefund, fee, calldata size, then simulates the whole batch. A provider response never bypasses
simulation or semantic validation.

## Base compatibility

The following remain unchanged:

- account and factory bytecode;
- account CREATE2 salt and EIP-712 domain/types;
- generic SDK client and launchpad-adapter interface;
- official Base CCTP privacy bridge engine;
- Clanker and Uniswap adapters; and
- Base relayer configuration.

Robinhood additions are chain manifests, a Pons adapter, a semantic relayer policy, tests, event
indexing, and a Relay transport composed around the official bridge. Relay routing does not branch
inside the CCTP engine.

## Observability without secret leakage

Persist operation IDs, public chain IDs, account index, public account/transaction addresses,
amount buckets, deadlines, provider status, and errors. Never persist or log identity signatures,
derived private keys, viewing keys, raw proof witnesses, wallet authentication payloads, or full
provider credentials. Hash or redact IP/user-agent data and disable third-party analytics on private
flow screens.

## Trust statement

Pons is non-custodial at execution but its owner controls mutable launch configuration and the V2
stack is still reported as under audit in its documentation. STRK20 protects note activity inside
the pool. Relay is trusted for liveness, correct conversion, and destination delivery and sees both
endpoints of each Relay order. Circle sees the CCTP messages. The relayer can censor but cannot
alter a signed batch. Robinhood's RPC/sequencer and the Starknet prover/RPC have their ordinary
infrastructure visibility.
