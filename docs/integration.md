# Host integration guide

## Reference frontend

`apps/demo` is currently the PrivatePons product: Private Balance, Relay + CCTP deposit, Pons V2
launch/buy/sell, positions, and S2 return status. The checked-in entry point starts
`createPrivatePonsLiveRuntime` and fails closed when live infrastructure is unavailable. Unit tests
inject a demo runtime explicitly.

For a real integration, construct `createLiveRuntime` with the configured
`PrivateLaunchpadClient`, host adapter, wallet connection/signing callbacks, and a mapper from the
host form values to its launch intent. The runtime retains the identity signature inside a closure;
React state receives only the connected address and derived public session. Do not add that
signature to global state, browser storage, analytics, error reporting, or logs.

The reference app's `createPrivatePonsLiveRuntime` completes the product binding. Internally,
`createPonsMainnetLiveClient` wires Robinhood and Arbitrum RPCs, deployed-factory preflight, the
integrity-checked mainnet bridge, strict Relay transports, and canonical HTTP relayer encoding. Pass
that client into `createLiveRuntime`. Keep the adapter and wallet callbacks in host code, and resolve
a fresh, non-secret account index from the position store rather than hard-coding index `0` for
every launch or trade.

## 1. Install and inject the bridge

The official bridge package is on GitHub Packages. Configure a token with `read:packages`, pin the
bridge version, and initialize its testnet configuration before constructing this plugin. Inject
`derivePolygonEoa`, `moveIntoPool`, `cashOut`, `fundAccountFromPool`, and `returnToPool` through
`createStarkwarePrivacyBridgeEngine` as shown in
[`packages/sdk/README.md`](../packages/sdk/README.md). The wrapper validates the bridge's string
address and private-key outputs before the client uses them.

If GitHub Packages authorization is unavailable, `pnpm build:official-bridge` provides a pinned
source boundary rather than a fork: it fetches exact official SDK and bridge commits, builds with
the upstream locks, validates the required exports, and emits an ignored browser bundle with a
SHA-256 provenance manifest. The authenticated surface includes the bridge's configuration
initializer as well as its movement functions. Initialize it with
`loadOfficialBridgeEngine({ environment, route })`; the loader refuses to expose the engine unless
the resolved route matches its pinned configuration. The default is the canonical STRK20 Sepolia
pool/anonymizers → Base Sepolia domain `6`. PrivatePons passes `route: "pons-mainnet"`, which forces
the canonical STRK20 mainnet pool/anonymizers, Starknet domain `25`, Arbitrum domain `3`, Fast CCTP,
an eligible OZ account class, AVNU paymaster, and same-origin RPC/prover/indexer paths. Review and
update the pinned commits intentionally when upstream releases change; never follow a mutable branch
in a production build.

`apps/demo/vite.config.ts` provides development-only same-origin proxies. Copy `.env.example` to an
ignored `.env.local` and supply the Starknet RPC, prover, indexer, and AVNU values there. The AVNU
credential is server-side; the browser carries only `same-origin-proxy`. A production host must
provide equivalent endpoints, use OHTTP for prover/discovery traffic, and overwrite the AVNU header
at its edge. Do not put RPC credentials, a real paymaster key, or an admin private key in `VITE_*`.

Never ask the user for a viewing key. The bridge's low-level SDK route is appropriate here because
the application derives and holds its own key material from the identity signature. A pure Starknet
Wallet API integration cannot control an EVM execution account or the reverse-CCTP signer.

## 2. Implement the adapter

The SDK includes concrete host adapters:

- `clankerV4LaunchAdapter` uses `clanker-sdk` V4 and prevents root-wallet metadata or recipients.
- `clankerTradeAdapter` consumes the same-origin `/v1/clanker/quote` route, checks that the quote is
  bound to the expected account/assets/amount, and relays the approve/swap calls.
- `ponsV2Adapter` reads the live Pons V2 factory/curve state and builds account-bound launch,
  pre-graduation buy, and pre-graduation sell calls on Robinhood.

The launch adapter also accepts an optional pre-encoded `dataSuffix`. This is appended exactly like
Clanker's official `DeployTokenOptions.dataSuffix`, so a host can attach its Base builder code
without changing deploy arguments or exposing the user's root wallet.

On Base mainnet, the quote route keeps `UNISWAP_API_KEY` server-side, disables Permit2 because the
funds live in a contract account, restricts routing to Uniswap AMMs, forces output back to the
position account, and validates approval calldata against Uniswap's proxy.

The hosted Trading API does not return Base Sepolia routes. On testnet, the same endpoint discovers
the PoolKey from Clanker's canonical locker, quotes against Uniswap's V4Quoter, waits through
Clanker's short post-launch sniper-auction window, and returns exact approval plus helper calls. The
deployed helper can only pull from its caller and can only return swap output to that caller.

If the host already returns transaction calls, use `preparedCallsAdapter`. Otherwise implement
`LaunchpadAdapter<OpenIntent, CloseIntent>` and return `{target, value, data}` calls from
`buildOpenCalls` and `buildCloseCalls`.

Use `approveCall` for exact ERC-20 approvals. Avoid unlimited approvals unless the per-position
account is intentionally dedicated to that token/host. Reject empty call plans, mismatched chains,
expired quotes, and zero targets before requesting a signature.

## 3. Fund one account per position

For first-time funding, call `depositToPrivateBalance`. A direct-CCTP client delegates to the
official bridge's `moveIntoPool` route. PrivatePons injects `createRelayDepositTransport`, which
routes R1 USDG through Relay to A1 on Arbitrum before `moveIntoPool` burns through CCTP. The source
wallet, amount, and time are public; later movement inside the pool is private.

For a user withdrawal, call `withdrawPrivateBalance`. It delegates to the official bridge's
resumable `cashOut` route and mints to the chosen EVM destination. This is another public edge:
destination, amount, and time are visible, while the pool note that funded it is hidden.

Call `deriveSession(signature, index)` before moving value. The returned account is counterfactual.
On a direct-CCTP host it can receive CCTP USDC immediately. PrivatePons injects
`createRelayFundingTransport`: CCTP forward-mints to Relay's strict Arbitrum deposit address and
Relay sends USDG to the Robinhood account. Call `fundSession` with a common denomination and retain
the in-flight cursor so refreshes resume rather than burn twice.

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

Use `createHttpRelay({ endpoint })` for the browser transport. It applies the relayer's canonical
decimal encoding to every bigint, refuses redirects and credential-bearing URLs, omits browser
credentials/referrers, bounds the request, and validates the returned transaction hash. Prefer a
same-origin endpoint; if the relayer is cross-origin, configure an exact CORS allowlist rather than
`*` and retain the same no-redirect policy at the reverse proxy.

## 5. Return value

Close/sell through the host first. A direct-CCTP host converts proceeds to native Circle USDC and
then calls `returnSession`; StarkWare's bridge owns the burn cursor, attestation, bound inbound
commitment, proof, and atomic open-note mint. PrivatePons injects `createRelayReturnTransport`: R2
transfers USDG to Relay, Relay funds position-specific A2 with Arbitrum USDC, A2 deposits into the
distinct S2 identity through CCTP, and S2 privately transfers to S1. Never clear an in-flight burn or
Relay request merely because polling timed out.

## Host-side adoption options

- **UI plugin:** add a "Private" mode that swaps the connected account for the plugin's execution
  account while continuing to use the host SDK.
- **SDK wrapper:** publish a host adapter package for third-party frontends.
- **API-prepared calls:** the host backend returns unsigned calls with quote/slippage metadata; the
  plugin validates and signs them.

No host-contract upgrade is required unless the host rejects contract accounts or hard-codes the
connected wallet as recipient.
