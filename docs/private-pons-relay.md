# PrivatePons Relay architecture

PrivatePons uses Pons V2 on Robinhood mainnet without modifying or redeploying Pons. The only
PrivatePons contract is the deterministic execution-account factory recorded in
`deployments/robinhood-mainnet.json`.

## Identity separation

One MetaMask identity signature derives several independent identities in memory:

- `pons-inbound-v1`: Arbitrum A1 used only for this root identity's public deposit edge;
- `pons-private-v1`: Robinhood R2 owner used only for one Pons position; and
- `PRIVATE_PONS_RETURN_IDENTITY_V1` plus `pons-return-staging-v1`: S2/A2 used only to return one
  position.

Raw signatures, viewing keys, and derived private keys are never stored or sent to Relay. The
private-funding path stores only a non-secret in-flight request ID, public addresses, amounts, and
the transaction hash needed to prevent a repeated STRK20 burn. Funding, position, and balance-rest
records use an opaque namespace derived from the app-scoped identity signature; v1 keys containing
R1 are migrated and removed. The records cannot move funds, but their public R2 metadata can still
be correlated by same-origin code during a live wallet session or by other process records.

## Deposit

1. R1 signs one Robinhood USDG transfer to a strict Relay deposit address.
2. Relay delivers native USDC and an ETH gas top-up to A1 on Arbitrum.
3. A1 is signed locally, without an Arbitrum wallet prompt, and burns USDC through Circle CCTP.
4. The official StarkWare bridge deposits the Starknet mint into the user's STRK20 balance.

This edge is public: R1, amount, and timing are visible. Privacy starts after the STRK20 deposit.

## Private buy or launch

1. STRK20 privately withdraws USDC through the canonical mainnet outbound anonymizer.
2. Circle Fast CCTP forward-mints to a strict Relay deposit address on Arbitrum.
3. Relay swaps/routes Arbitrum USDC to Robinhood USDG at counterfactual account R2.
4. R2 signs a Pons launch, buy, or sell batch; the project relayer pays Robinhood gas.

The app validates Relay's chain IDs, tokens, exact input amount, ERC-20 transfer calldata, output
minimum, and deposit address before the irreversible STRK20 burn. It persists that path's Relay
request and burn cursor so a reload resumes status polling instead of burning again.

## Private sell return

1. R2 sells on the public Pons curve and transfers USDG to a strict Relay deposit address.
2. Relay delivers Arbitrum USDC to position-specific A2.
3. A2 bridges into a distinct STRK20 S2 identity.
4. S2 privately transfers the note inside STRK20 to the user's main S1 balance.

Before broadcasting step 1, the policy relayer uses its server-side Relay API credential to resolve
the supplied request ID. It fails closed unless Relay reports the same R2 user, R2 owner refund
address, strict deposit address, Robinhood USDG input, exact amount, Arbitrum USDC output, and a
fresh executable request. The request ID is policy metadata; the transfer call itself remains bound
by R2's EIP-712 execution signature.

R2 and S2/A2 are position-specific. R1 and the main S1 balance are stable user edges, while A1 is a
domain-separated deposit account for that root identity. Relay still observes the two endpoints of
each order, and timing/amount correlation remains possible; the product must not claim perfect
anonymity.

## What “R1 is disconnected from R2” means

The implemented route creates no direct onchain R1 ↔ R2 transfer, shared owner, or gas-funding
edge. Pons and ordinary public-chain observers therefore see R2's public activity without a
deterministic ownership link to R1. This guarantee does not extend to the user's browser, the app's
same-origin infrastructure, Relay's service metadata, the STRK20 auditor, or an observer that can
correlate distinctive amounts and timing.

## Mainnet gates

- Keep `RELAY_API_KEY`, `RELAY_QUOTE_ATTESTATION_KEY`, the AVNU key, RPC credentials, and relayer
  key server-side.
- Run a small-value canary before enabling unrestricted amounts. In particular, verify Circle's
  forward mint is detected by Relay's strict deposit address and that Relay gas top-up covers the A1
  CCTP transaction. Deposit and sell-return Relay legs are not yet recoverable across a browser
  crash before their downstream CCTP cursor exists, so keep the UI session open during the canary.
- The Robinhood relayer needs ETH for transaction gas and the exact live Pons launch prefund
  (`launchFee()` currently gates launch requests).
- Production prover/indexer traffic should use the planned OHTTP gateways; the local Vite proxies
  are development infrastructure.
