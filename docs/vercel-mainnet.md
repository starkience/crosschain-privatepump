# Vercel mainnet deployment

PrivatePons deploys from the repository root. The committed `vercel.json` builds the frontend into
`apps/demo/dist` and exposes the two source-controlled Node functions under `api/`.

## Build boundary

Vercel runs:

```sh
pnpm build:vercel
```

That command rebuilds the ignored official privacy-bridge browser artifact from the exact pinned
SDK and bridge commits, applies the reviewed transport-only prover retry settings, records them in
the integrity manifest, builds the local SDK, and builds the frontend. A clean clone therefore does
not depend on an ignored artifact left on a developer machine.

The two functions are:

- `api/proxy.ts`: allowlisted RPC, AVNU, Relay, discovery, and selectable mainnet prover transport.
- `api/private-relayer.ts`: Pons semantic-policy relayer.

Do not deploy `apps/demo/dist` as a separate static project. The repository-root deployment is what
keeps the functions and rewrites attached to the frontend.

## Required protection

Use a protected Preview deployment for the first canary. Until authentication and rate limiting are
added, a public URL could consume prover capacity, Relay/AVNU quota, or relayer gas. Do not
promote the deployment to Production merely because the build succeeds.

## Server-only environment

Configure these in Vercel Preview scope and redeploy:

```text
PROVER_PROVIDER=starkware
STRK20_MAINNET_PROVER_URL
STARKSCAN_PROVER_URL
STARKSCAN_API_KEY
PROVER_STATE_ENCRYPTION_KEY
STARKNET_MAINNET_RPC_URL
STRK20_MAINNET_INDEXER_URL
ARBITRUM_RPC_URL
ROBINHOOD_RPC_URL
AVNU_PAYMASTER_URL
AVNU_PAYMASTER_API_KEY
RELAY_API_URL
RELAY_API_KEY
CHAIN_ID
EXECUTION_DOMAIN_NAME
RPC_URL
FACTORY_ADDRESS
RELAYER_PRIVATE_KEY
RELAYER_FEE_AMOUNT
PONS_V2_POLICY
MAX_PREFUND_WEI
RELAY_RETURN_MAX_QUOTE_AGE_SECONDS
```

If `RELAYER_FEE_AMOUNT` is nonzero, also configure `RELAYER_FEE_TOKEN` and
`RELAYER_FEE_RECIPIENT`. Keep `ALLOW_UNSAFE_ANY_TARGETS=false`.

Link an Upstash for Redis resource to the project. Its managed `KV_REST_API_URL` and
`KV_REST_API_TOKEN` variables are accepted directly. For a separately managed compatible service,
set `PROVER_STATE_REST_URL` and `PROVER_STATE_REST_TOKEN` instead.
Generate the cache encryption key locally with:

```sh
openssl rand -hex 32
```

Never prefix these server values with `VITE_`.

## Public build environment

The mainnet browser profile requires:

```text
VITE_NETWORK=mainnet
VITE_RUNTIME_MODE=live
VITE_LAUNCHPAD=pons
VITE_CCTP_FAST=true
VITE_CCTP_DEFAULT_DEST_CHAIN_ID=42161
VITE_OZ_ACCOUNT_CLASS_HASH_MAINNET
VITE_ROBINHOOD_RPC_URL=/robinhood-rpc
VITE_ARBITRUM_RPC_URL=/arbitrum-rpc
VITE_RELAY_BRIDGE_URL=/api/relay
VITE_AVNU_PAYMASTER_URL=/api/avnu
VITE_AVNU_PAYMASTER_API_KEY=same-origin-proxy
VITE_PRIVATE_LAUNCHPAD_FACTORY
VITE_PRIVATE_LAUNCHPAD_RELAYER_URL=/api/private-launchpad/v1/relay
```

## Gates before funds move

1. The selected mainnet prover responds to a non-proving JSON-RPC validation request. For the
   optional fallback, `pnpm preflight:starkscan` authenticates the approved key without creating a
   job.
2. The protected deployment loads the pinned bridge manifest and reports live mainnet mode.
3. `/api/private-launchpad/healthz` returns `readyForBroadcast: true`.
4. RPC chain IDs, deployed factory bytecode, a Relay quote, and AVNU availability pass through the
   deployed same-origin routes.
5. A malformed request to `/prover/mainnet` reaches the selected prover adapter and is rejected as
   invalid JSON-RPC; it must never return `privacy-service path is not allowed`.

Only then run the minimum-size funded deposit → existing-token buy → sell/return canary. Keep the
same normal browser profile throughout so the bridge recovery cursors remain available.
