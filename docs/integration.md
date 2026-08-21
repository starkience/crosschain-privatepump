# Host integration guide

## 1. Install and inject the bridge

The official bridge package is on GitHub Packages. Configure a token with `read:packages`, pin the
bridge version, and initialize its testnet configuration before constructing this plugin. Inject
`derivePolygonEoa`, `fundAccountFromPool`, and `returnToPool` as shown in
[`packages/sdk/README.md`](../packages/sdk/README.md).

Never ask the user for a viewing key. The bridge's low-level SDK route is appropriate here because
the application derives and holds its own key material from the identity signature. A pure Starknet
Wallet API integration cannot control an EVM execution account or the reverse-CCTP signer.

## 2. Implement the adapter

If the host already returns transaction calls, use `preparedCallsAdapter`. Otherwise implement
`LaunchpadAdapter<OpenIntent, CloseIntent>` and return `{target, value, data}` calls from
`buildOpenCalls` and `buildCloseCalls`.

Use `approveCall` for exact ERC-20 approvals. Avoid unlimited approvals unless the per-position
account is intentionally dedicated to that token/host. Reject empty call plans, mismatched chains,
expired quotes, and zero targets before requesting a signature.

## 3. Fund one account per position

Call `deriveSession(signature, index)` before moving value. The returned account is counterfactual
and can receive CCTP USDC immediately. Call `fundSession` with a common denomination and retain the
bridge's in-flight cursor so refreshes resume rather than burn twice.

Do not derive an index only from a token address: repeated users would collide within their own
history. Persist a non-secret monotonic counter and the host position metadata. Never persist the
derived private key or identity signature.

## 4. Relay host calls

The SDK signs the account batch and calls the injected relayer. The included relayer validates the
factory, account derivation, chain, signature, nonce, deadline, prefund, fee, call count, calldata
size, and optional target allowlist before simulation and broadcast.

Production relayers need rate limiting, abuse controls, durable transaction-status tracking, and a
separate privacy review. A thrown HTTP response is ambiguous after broadcast; poll the account nonce
and chain receipt before asking the user to sign a replacement.

## 5. Return value

Close/sell through the host first. Convert proceeds to native Circle USDC in a separate host batch.
Then call `returnSession`. StarkWare's bridge owns the burn cursor, Circle attestation, bound inbound
commitment, proof, and atomic open-note mint. Never clear an in-flight burn merely because polling
timed out.

## Host-side adoption options

- **UI plugin:** add a "Private" mode that swaps the connected account for the plugin's execution
  account while continuing to use the host SDK.
- **SDK wrapper:** publish a host adapter package for third-party frontends.
- **API-prepared calls:** the host backend returns unsigned calls with quote/slippage metadata; the
  plugin validates and signs them.

No host-contract upgrade is required unless the host rejects contract accounts or hard-codes the
connected wallet as recipient.
