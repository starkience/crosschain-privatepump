# Research record

Snapshot date: 2026-08-21. Revalidate before release.

## STRK20 and privacy bridge

- [`starkware-libs/starknet-privacy`](https://github.com/starkware-libs/starknet-privacy), inspected
  at `36eac4ea88cd8c59dde1493176e16501c6e90328`. It defines the note/nullifier model, actions,
  proofs, discovery, pool contract, SDK, and anonymizer examples.
- [STRK20 by Example](https://strk20-by-example.org/) and the installed STRK20 integration skills
  were used for the hidden/public boundary, Wallet API and SDK constraints, note maturity, proof
  aging, compliance screening, and Sepolia pool address.
- [`starkware-libs/privacy-bridge`](https://github.com/starkware-libs/privacy-bridge), inspected at
  `0798ac522ec38c0af9cff53b6fd1f7b44a1acfdd`. Version `0.1.21` supports Base/Base Sepolia as CCTP
  source and destination chains. Its outbound anonymizer burns pool-withdrawn USDC to an EVM
  recipient; its inbound anonymizer binds attested hook data to an authenticated pool identity and
  atomically mints into an open note.
- The bridge's package currently requires GitHub Packages authorization. Its key derivation,
  discovery, proving, cursor recovery, and CCTP logic are injected rather than copied here.
- Compatibility was checked by building the tagged bridge package `0.1.21` against its declared
  Privacy SDK peer `0.14.3-rc.3`, packing both from source, and compiling the plugin adapter against
  the emitted declarations. The bridge returns unbranded string key/address fields, so
  `createStarkwarePrivacyBridgeEngine` performs the required runtime validation and type branding.
- Source-build compatibility was reverified on 2026-08-24 against bridge `v0.1.22`
  (`3e95694b997069c47eff52cd576af0bb3e03612d`) and its declared Privacy SDK `0.14.3-rc.3`
  (`efc61cbbdab5b714b5cf915f9735d88948e2ea82`). A clean build exposed `derivePolygonEoa`,
  `fundAccountFromPool`, and `returnToPool`. `scripts/build-official-bridge.mjs` pins these commits
  so the package-auth path has a source-provenance fallback without committing or modifying
  upstream cryptography.

## Offmarket lesson

- [`starkware-libs/offmarket`](https://github.com/starkware-libs/offmarket), inspected at
  `40f898a71686ddff1f6fe4da8565b4e93fe010f2`. It proves the useful split: a framework-agnostic
  bridge owns value movement and app callbacks own the venue. Offmarket derives one EVM account per
  position, bridges fixed USDC denominations through CCTP, trades publicly from that account, and
  returns USDC through the inbound anonymizer. Its resumable burn/attest/mint cursors and explicit
  observer threat model are adopted here.

## EVM launchpads

- [`clanker-devco/v3.1-contracts`](https://github.com/clanker-devco/v3.1-contracts), inspected at
  `6a399e38b3ef6024f3e4117ab326b044536e758a`. Clanker creates a token and Uniswap V3 pool, installs
  single-sided token liquidity, locks the LP NFT, and can perform an initial payable swap.
- [`flayerlabs/flaunchgg-contracts`](https://github.com/flayerlabs/flaunchgg-contracts) was inspected
  for its Uniswap V4 PositionManager/hook lifecycle, fair-launch schedule, premine, fee distribution,
  and continuing pool liquidity.
- The predecessor PrivatePump implementation was inspected for the third common model: factory
  deployment, bonding-curve inventory/reserve trading, threshold graduation, and AMM liquidity
  migration.

The cross-model invariant is that the launchpad owns liquidity mechanics. The plugin only changes
which account supplies/receives assets and how that account is funded.
