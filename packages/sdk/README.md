# `@private-launchpad/sdk`

This package lets an existing EVM launchpad add a STRK20-backed private mode without changing its
contracts. It coordinates three independent layers:

1. StarkWare's privacy bridge moves USDC from the STRK20 pool to a fresh, deterministic EVM
   execution account.
2. A host adapter supplies the same calls its public UI already submits for launch, buy, sell, or
   claim.
3. A relayer deploys the counterfactual account when needed and submits the owner-signed call batch.

The SDK never asks for a viewing key. Its identity signature and derived EVM owner key must remain
in browser memory and must never be logged or persisted.

```ts
import {
  createPrivateLaunchpadIdentityMessage,
  createHttpRelay,
  createStarkwarePrivacyBridgeEngine,
  PrivateLaunchpadClient,
  preparedCallsAdapter,
} from "@private-launchpad/sdk";
import {
  derivePolygonEoa,
  fundAccountFromPool,
  returnToPool,
} from "@starkware-libs/starknet-privacy-bridge";

const plugin = new PrivateLaunchpadClient({
  chainId: 84532,
  factory: PRIVATE_ACCOUNT_FACTORY,
  usdc: BASE_SEPOLIA_USDC,
  publicClient,
  relay: createHttpRelay({ endpoint: "/api/private-launchpad/v1/relay" }),
  bridge: createStarkwarePrivacyBridgeEngine({
    derivePolygonEoa,
    fundAccountFromPool,
    returnToPool,
  }),
});

const identitySignature = await walletClient.signMessage({
  account: connectedEvmAddress,
  message: createPrivateLaunchpadIdentityMessage("your-launchpad.example"),
});

const session = await plugin.deriveSession(identitySignature, 0);
await plugin.fundSession({
  signature: identitySignature,
  accountIndex: 0,
  amount: 10_000_000n,
  connectedEvmAddress,
});

const adapter = preparedCallsAdapter("existing-launchpad", 84532);
await plugin.open({
  signature: identitySignature,
  session,
  adapter,
  intent: { calls: hostSdkPreparedCalls },
});
```

The host adapter owns pricing, slippage, token discovery, phase transitions, and receipt parsing.
The plugin owns private funding, deterministic account control, relayed execution, resumability, and
the return-to-pool path.

The bridge is injected because StarkWare currently distributes it through GitHub Packages. Pin the
official package and its Starknet peer versions in the consuming application, then pass the three
exports shown above. The repository's optional `pnpm build:official-bridge` fallback compiles exact
upstream commits into a local ignored browser artifact when package access is unavailable. The
plugin never vendors or forks bridge cryptography.
