# Reference frontend

This Vite application demonstrates how an existing launchpad can add a private execution mode while
keeping its current launch form, factory, quotes, and liquidity lifecycle. It starts in an explicit
simulation mode: no wallet is contacted and every address or transaction hash shown by the flow is
sample data.

The production seam is `createLiveRuntime` in `src/runtime.ts`. A host injects its configured
`PrivateLaunchpadClient`, launchpad adapter, wallet connection/signing callbacks, and intent mapper.
The runtime deliberately keeps the identity signature inside a closure so React state, browser
storage, analytics, and logs never receive it.

```sh
pnpm --filter @private-launchpad/demo dev
```

Do not relabel the app as live until the Base account factory, relayer, official privacy bridge,
proving service, discovery service, Circle attestation path, and host adapter have all passed the
Sepolia verification runbook.
