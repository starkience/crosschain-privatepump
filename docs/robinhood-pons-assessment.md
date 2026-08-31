# Robinhood Chain + Pons assessment

Research snapshot: 2026-08-26; transport implementation updated 2026-08-31. Live Pons reads in this
document use Robinhood Chain block `46,741,521` (`0xcb37…e03c`). Re-run every live-state gate and
minimum-size transport canary immediately before a release.

## Decision

Proceed with the current Pons V2 contracts and the implemented two-provider route:

```text
STRK20 on Starknet ↔ Circle CCTP V2 ↔ native USDC on Arbitrum ↔ Relay ↔ USDG on Robinhood
```

Circle does not publish a Robinhood CCTP domain, so CCTP is used only between Starknet and
Arbitrum. Relay performs the Arbitrum USDC ↔ Robinhood USDG hop. The browser validates the strict
Relay deposit transaction and the official privacy bridge binds the CCTP leg to the configured
Starknet/Arbitrum domains.

This route preserves the primary onchain property—Pons never sees the connected/root wallet—but it
is not a private bridge. Relay sees both endpoints of each Relay order, Circle sees CCTP messages,
and service metadata plus amount/timing can correlate edges. A minimum-size mainnet canary remains
mandatory before general release.

## Live deployment snapshot

| Item                          | Value at the snapshot                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Robinhood mainnet             | chain ID `4663`, native gas token ETH                                                          |
| Robinhood testnet             | chain ID `46630`                                                                               |
| Pons V2 factory               | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`                                                   |
| Pons V1 factory               | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`                                                   |
| Pons V2 launch-and-buy router | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948`                                                   |
| Robinhood USDG                | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals                                       |
| V2 launch gate                | `launchEnabled() == true`; arbitrary derived account passes `canLaunch`                        |
| V2 launch fee                 | `0.0005 ETH`                                                                                   |
| V2 config `0`                 | enabled; supply `1e27`; 1% curve fee; `1.68 ETH` phantom quote; `4.2 ETH` graduation threshold |
| USDG pair                     | approved; phantom quote `3,236 USDG`; graduation threshold `8,090 USDG`                        |
| USDG launch economics digest  | `0x7909a028ec0fee3564b05d53b74cd91d79786f17ac5aa90be360c0b78201e86a`                           |
| Pons testnet                  | no bytecode at the documented V1 or current/stale V2 mainnet addresses                         |

Pons addresses and mutable values must be read from a versioned deployment manifest and confirmed
onchain. Search indexes still surface an older V2 factory (`0x7E1E…4dB8`), while the current
[Pons V2 documentation](https://docs.ponsfamily.com/v2) and live contract use `0x7eD5…EC7e`.

## Pons V2 call surface

### Launch

The direct entrypoint is:

```solidity
launchToken(TokenParams params, uint256 launchConfigId, address pairToken)
    payable returns (address token, address curve)
```

`TokenParams` contains name, symbol, logo, description, five social links, creator fee recipient,
creator tax, buyback flag, an optional economics digest, and a CREATE2 salt. The factory:

- authorizes `originalDeployer`, which is `msg.sender` on the direct path;
- never uses `tx.origin` and does not reject contract callers;
- defaults a zero creator-fee recipient to that original deployer;
- records and emits the execution account as deployer;
- requires exact `msg.value == launchFee` even for a USDG-quoted launch;
- requires USDG to remain approved and the selected launch config to remain enabled; and
- supports a nonzero `expectedEconomics` digest so mutable protocol terms cannot move under a
  signed launch.

For a private launch, call the factory directly from the per-launch execution account and set the
creator-fee recipient to that same account. The relayer may provide the exact launch fee through the
signed, bounded account prefund. Do not use the trusted `launchTokenFor` path: only Pons's configured
forwarder may call it, and the direct path already attributes the execution account correctly.

### Buy and sell before graduation

Each launch has its own `PonsV2BondingCurve`:

```solidity
buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)
```

Both calls accept a contract caller and an explicit recipient. A USDG buy is an exact USDG approval
followed by `buy` with zero native value. A sell is an exact token approval followed by `sell` with
the execution account as recipient. The adapter must reproduce Pons's integer quote math from live
curve state, apply a user slippage bound, and simulate immediately before relay; Pons intentionally
does not expose a quote function.

### After graduation

`getLaunchedToken(token).phase` is authoritative:

- `0` — trade on the bonding curve;
- `1` — swept; temporarily not tradable through the curve, and the V4 pool is not ready;
- `2` — trade through the launch's Uniswap V4 pool and Pons meme hook; or
- `3` — rescued; do not assume a normal Pons market.

The curve adapter must reject every phase except `0`. Supporting all existing Pons markets also
requires a V4 route constrained to the pool key and hook recorded by the token's factory stack.
Never silently route a graduated token back to its closed curve.

### Launch discovery and shared markets

There is no Pons API in the trust path. Index `TokenLaunched` on each known factory stack, then index
the emitted curve. A launch made by the execution account is an ordinary Pons launch and appears in
the same onchain event stream used by other Pons interfaces. The product does not deploy a private
fork of the launchpad or fragment liquidity.

## Execution-account compatibility

| Requirement              | Result            | Evidence / implication                                                                                  |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------- |
| Contract caller accepted | Pass              | V2 launch, buy, and sell do not use `tx.origin`, `extcodesize`, or EOA signature gates.                 |
| Explicit recipient       | Pass              | Curve buy/sell accept `recipient`; bind it to the execution account.                                    |
| Creator attribution      | Pass              | Direct launch records `msg.sender`; this is the execution account, not the root wallet.                 |
| Counterfactual funding   | Pass              | USDG can arrive before account deployment; CREATE2 account deployment and calls occur atomically later. |
| Gasless first action     | Pass with relayer | Relayer pays gas; signed prefund supplies exact launch ETH where needed.                                |
| ERC-20 custody           | Pass              | The account can approve, receive, hold, and transfer USDG and launch tokens.                            |
| Relayed authorization    | Pass              | Existing account binds chain, address, calls, nonce, deadline, fee, and prefund in EIP-712.             |
| Testnet end-to-end Pons  | Blocked upstream  | No documented V2 testnet deployment was found; use a Robinhood mainnet fork until Pons provides one.    |

The smart-account proof gate passed on 2026-08-26. `PonsV2ForkTest` deployed the existing
account/factory on a live-state fork of chain `4663`, prefunded a counterfactual account with USDG,
launched an actual Pons V2 USDG pair, bought, sold the complete token balance, and confirmed that
assets, deployer attribution, and creator attribution remained at the execution account. The test
is deliberately conditional in the ordinary offline suite and can be repeated with:

```sh
forge test --fork-url https://rpc.mainnet.chain.robinhood.com \
  --match-contract PonsV2ForkTest -vv
```

This proves the direct Pons execution path. It does not prove transport delivery, refunds, or the
privacy bridge; those retain separate gates below.

## Privacy assessment

### Hidden

- STRK20 note ownership, internal sender/receiver, balances, and note-to-note amounts while funds
  remain in the pool.
- The connected/root EVM wallet from Pons, assuming it never funds the execution account or pays its
  gas directly.
- The identity-derived EVM owner key, provided its signature and private key stay memory-only.
- Unrelated positions from each other when each uses a fresh account index and channel discipline.

### Public or provider-visible

- STRK20 withdrawal/deposit edges: asset, amount, recipient/helper, and time.
- Relay order: source and destination networks, assets, requested and delivered amounts,
  source transaction, destination address, refund address, status, fees, and timing.
- Robinhood execution account, Pons factory/curve/pool, calldata, launch metadata, creator tax,
  balances, approvals, trade sizes, prices, and timestamps.
- Relayer request contents and network metadata. RPC, sequencer, Relay, relayer, and prover
  operators have their normal service-level visibility.

Relay can link the two endpoints of each order by design. It is not given the identity signature or
STRK20 viewing key, but fixed or bucketed amounts, delayed execution, fresh per-position accounts,
independent relaying, and avoiding root-wallet gas funding do not prevent service-level
correlation. Browser recovery records now use a signature-derived opaque namespace rather than an
R1-address key, but same-origin code observing the live wallet session or other process records can
still reconstruct the local R1 ↔ R2 mapping.

## Principal risks and controls

| Risk                                 | Required control                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Stale or replaced Pons stack         | Pin a manifest version, confirm bytecode, and resolve each token's factory stack from indexed events.                         |
| Mutable launch terms                 | Read `canLaunch`, config, USDG approval, fee, and `previewLaunchEconomics`; sign the nonzero digest.                          |
| Wrong Pons phase                     | Read the factory launch record and fail closed for swept/rescued/unsupported V4 routes.                                       |
| Malicious prepared calls             | Decode every selector and argument; bind factory, curve/token relationship, recipient, assets, values, amounts, and slippage. |
| Dynamic curve/token targets          | Relayer validates them against the factory launch record; a static target allowlist alone is insufficient.                    |
| Infinite approvals                   | Use exact approval immediately before use and reset only when a non-standard token requires it.                               |
| USDG without ETH                     | Relayer supplies only the signed, policy-capped prefund required for launch fee; buys/sells stay USDG-denominated.            |
| Relay/Circle correlation             | State it in product copy; never call the transport perfectly anonymous or trustless.                                          |
| Quote expiry / partial settlement    | Persist the order before transfer; use explicit min receive, expiry, refund address, and resumable status polling.            |
| Return cannot atomically open a note | Deliver to a fresh Starknet recovery account, then open a new STRK20 note as a separate resumable step.                       |
| Root-key leakage                     | Domain-separated identity signature; derived secret and raw signature never persist or enter logs/analytics.                  |

## Go/no-go gates

Proceed to a limited MVP only when all of these are true. Implementation and automated tests cover
gates 1 and 4; gates 2, 3, and 5 remain release requirements:

1. **Passed:** the Robinhood mainnet-fork smart-account launch/buy/sell test passes against the
   current Pons V2 stack, including execution-account creator/deployer attribution. The adapter and
   relayer separately reject non-curve phases; a graduated V4 execution path is Phase 2.
2. A minimum-size mainnet test confirms both Arbitrum USDC→Robinhood USDG and Robinhood
   USDG→Arbitrum USDC, CCTP forwarding in both directions, fresh recipients, gas top-up, refund
   behavior, quote expiry, and crash recovery.
3. The pinned official STRK20 privacy bridge and canonical anonymizers are independently reviewed;
   the resolved mainnet configuration is checked before the browser can use it.
4. The relayer semantic policy recognizes the Pons factory, curve, token, USDG, and exact Relay
   return transfer, and rejects approvals or recipients outside the execution account's intent.
5. Product copy and telemetry follow the privacy boundary above.

## Primary sources

- [Robinhood Chain connection parameters](https://docs.robinhood.com/chain/connecting/)
- [Robinhood EVM deployment guide](https://docs.robinhood.com/chain/deploy-smart-contracts/)
- [Pons V2 integration documentation](https://docs.ponsfamily.com/v2)
- [Pons contract source](https://github.com/ponsdotdev/ponsfamily)
- [STRK20 privacy bridge v0.1.22 source](https://github.com/starkware-libs/privacy-bridge/tree/v0.1.22)
- [Circle CCTP domains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains)
- [Circle CCTP contract addresses](https://developers.circle.com/cctp/references/contract-addresses)
- [Relay quote API](https://docs.relay.link/references/api/get-quote-v2)
- [Relay supported chains API](https://docs.relay.link/references/api/get-chains)
