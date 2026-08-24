# Reference frontend

This Vite application demonstrates how an existing launchpad can add a private execution mode while
keeping its current launch form, factory, quotes, and liquidity lifecycle. It starts in an explicit
simulation mode: no wallet is contacted and every address or transaction hash shown by the flow is
sample data.

The production seam is `createLiveRuntime` in `src/runtime.ts`. A host injects its configured
`PrivateLaunchpadClient`, launchpad adapter, wallet connection/signing callbacks, and intent mapper.
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
builds both packages, validates the three exports consumed by this plugin, and writes an ignored
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

Do not relabel the app as live until the Base account factory, relayer, official privacy bridge,
proving service, discovery service, Circle attestation path, and host adapter have all passed the
Sepolia verification runbook.
