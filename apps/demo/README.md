# Reference frontend

This Vite application is the Plank reference product. It includes a consumer-facing
Private Balance, explicit public-edge deposit, Clanker V4 launch form, Uniswap buy/sell flow,
position route, and return-to-balance state. It starts in preview mode: no wallet is contacted and
every address or transaction hash is sample data.

The complete production binding is `createPrivateClankerLiveRuntime` in `src/clanker-live.ts`. It
combines `createLiveRuntime`, the configured `PrivateLaunchpadClient`, current Clanker V4 adapter,
server-keyed Uniswap trade adapter, injected EVM wallet, and form intent mappers.
The runtime deliberately keeps the identity signature inside a closure so React state, browser
storage, analytics, and logs never receive it.

`createBaseSepoliaLiveClient` in `src/live-client.ts` provides the concrete infrastructure half of
that binding. It checks the RPC chain and deployed factory bytecode before it loads the bridge,
initializes the authenticated official bridge module, and connects the SDK to the HTTP policy
relayer. The host still supplies its wallet callbacks, adapter, and monotonic position index; those
cannot be guessed safely by a generic plugin.

The preferred bridge installation remains the signed package from GitHub Packages. When package
authorization is unavailable, the repository can build the browser module directly from exact
official commits:

```sh
pnpm build:official-bridge
```

That command checks out the bridge and Privacy SDK source, uses the upstream dependency locks,
builds both packages, validates the five movement/derivation exports consumed by this plugin, and writes an ignored
browser bundle plus provenance manifest under `public/vendor`. The app can load it with
`loadOfficialBridgeEngine({ environment: import.meta.env })`; no upstream source or generated
cryptography is committed here. The loader initializes the upstream config and verifies the exact
STRK20 Sepolia → Base Sepolia route, OZ account class, paymaster, and same-origin privacy-service
paths before returning an engine. The
integrity-checked loader imports the verified bytes from a blob URL, so a strict production Content
Security Policy must intentionally permit `blob:` in `script-src` for this fallback. Prefer the
normal package-bundled path when that CSP exception is undesirable.

```sh
pnpm --filter @private-launchpad/demo dev
```

The Vite server proxies privacy services, AVNU, RPCs, Relay, and the policy relayer from the same
origin. On mainnet, `/prover/mainnet` adapts the Privacy SDK's existing synchronous JSON-RPC call to
Starkscan's asynchronous proving jobs. Set `STARKSCAN_PROVER_URL` and `STARKSCAN_API_KEY` only in
the server environment; the key must never use `VITE_` or appear in browser code. Run
`pnpm preflight:starkscan` to authenticate the key, verify its `prove` scope, and safely check that
the mainnet route is enabled without creating a proof job.

The production proxy additionally requires an Upstash-compatible Redis REST store. It keeps a
non-sensitive job cursor for safe idempotent retries and encrypts the complete one-time proof result
with `PROVER_STATE_ENCRYPTION_KEY` before retaining it for at most five minutes. Development uses a
process-local store; production fails with HTTP 503 before creating a proof when durable storage is
not configured.

Copy `.env.example` to `.env.local`; keep preview mode until every live value is set.
`UNISWAP_API_KEY`, `AVNU_PAYMASTER_API_KEY`, `RELAY_API_KEY`, and `STARKSCAN_API_KEY` stay
server-side and must never use `VITE_`.

Do not relabel the app as live until the Base account factory, relayer, official privacy bridge,
proving service, discovery service, Circle attestation path, host adapter, and Base Sepolia Uniswap
proxy route have all passed the Sepolia verification runbook. The live binding fails closed if the
API returns an approval spender or swap target other than the configured proxy.
