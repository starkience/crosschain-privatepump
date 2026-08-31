# Historical bridge transport analysis: Starknet USDC ↔ Robinhood USDG

Research snapshot: 2026-08-26. Routes, fees, assets, and supported chains are mutable service state.

> **Superseded decision record.** This document preserves the candidate research that preceded the
> implementation. It is not the current architecture. PrivatePons now composes Circle CCTP V2
> between Starknet and Arbitrum with Relay between Arbitrum and Robinhood. See
> `private-pons-relay.md` for the current route.

## Required transport properties

The target flow is not merely “some asset arrives on Robinhood.” It must:

1. accept Starknet USDC originating from a STRK20 external invocation;
2. deliver the supported Pons quote asset, USDG, to an arbitrary counterfactual Robinhood account;
3. reverse USDG into Starknet USDC to a fresh recovery recipient;
4. expose minimum receive, expiry, fees, refund behavior, order ID, and resumable status;
5. accept smart-contract senders and recipients without a `tx.origin`/EOA assumption;
6. make operator and public linkage explicit; and
7. never be confused with CCTP's recipient-bound attestation and atomic note opening.

## What the Base CCTP bridge guarantees

The current Base path uses Circle CCTP V2 and StarkWare's privacy bridge v0.1.22.

Outbound, an authenticated STRK20 withdrawal reaches a pool-only anonymizer, which exact-approves
Circle's Starknet TokenMessenger and burns USDC to an arbitrary 20-byte EVM recipient. Inbound, the
execution account burns USDC with hook data containing a commitment to the authenticated pool
identity. Circle signs the full message. The Starknet inbound anonymizer verifies the attested
message, destination caller, and commitment, calls `receive_message`, measures the exact minted
USDC, and opens the note in the same transaction.

That gives the Base implementation:

- canonical USDC burn/mint rather than an inventory swap;
- a Circle-signed source/destination domain and recipient;
- commitment bytes carried in the attested message;
- a destination-caller gate;
- a replayable, nonce-protected receive step; and
- atomic mint plus STRK20 note opening.

Circle's current [supported domain list](https://developers.circle.com/cctp/concepts/supported-chains-and-domains)
and [contract-address list](https://developers.circle.com/cctp/references/contract-addresses) do not
include Robinhood Chain. Robinhood also has USDG, not Circle-native USDC, as the Pons-approved stable
pair. Direct reuse is therefore unavailable.

## Live asset compatibility

Pons V2 currently approves Global Dollar at
`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals). The live factory stores USDG-specific
phantom quote and graduation threshold values, so creators and traders can remain USDG-denominated
from launch through the curve and graduated V4 pool.

This is important: a USDC→USDG bridge-swap does not require a second onchain conversion before a
Pons buy. The account still needs ETH for gas and the `0.0005 ETH` launch fee; the relayer can supply
the latter as a signed, bounded prefund.

## Candidate comparison

| Property                        | Direct CCTP                                      | Layerswap                                                           | Rhino.fi                                                                  |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Robinhood support now           | No published domain/contracts                    | Yes in live API                                                     | Yes in live UI; published docs lag                                        |
| Starknet USDC → Robinhood USDG  | No                                               | Live quote confirmed                                                | Plausible; credentialed quote not yet confirmed                           |
| Robinhood USDG → Starknet USDC  | No                                               | Live quote confirmed                                                | Screenshot/UI route confirmed                                             |
| Arbitrary destination           | CCTP mint recipient                              | API `destination_address`                                           | API/UI recipient / smart deposit address                                  |
| Counterfactual EVM recipient    | Yes                                              | Expected; must execute-test                                         | Expected; must execute-test                                               |
| Source contract support         | Yes through purpose-built anonymizer             | Depository accepts contract callers; Starknet action must be tested | Deposit-address transfer is promising; direct contract use is unsupported |
| Cryptographic hook/commitment   | Yes                                              | None documented                                                     | Commitment ID is backend order data, not a STRK20 commitment proof        |
| Atomic destination note opening | Yes                                              | No                                                                  | No                                                                        |
| Operator maps both edges        | Circle sees messages; public correlation remains | Yes, by order                                                       | Yes, by deposit-address/order record                                      |
| API credentials                 | Circle attestation API is public                 | API key                                                             | JWT/API key                                                               |
| Open-source deposit code        | CCTP + privacy bridge                            | EVM depository published                                            | Public audit contracts; normal direct use explicitly unsupported          |
| Refund/recovery                 | CCTP message can be retried                      | Provider order/status/refund state                                  | Provider order/status/refund state                                        |

## Layerswap findings

The live `GET /api/v2/networks` response lists:

- Starknet native USDC at `0x033068…b35fb`; and
- Robinhood USDG at `0x5fc536…1d168`.

Both addresses were independently checked against their chain. The live API produced routes in
both directions. A representative 100-unit quote at the research snapshot returned approximately:

| Direction                          |    Receive | Reported fee | Average completion | Path                            |
| ---------------------------------- | ---------: | -----------: | -----------------: | ------------------------------- |
| 100 Starknet USDC → Robinhood USDG | 99.68 USDG |    0.31 USDC |             11.2 s | Layerswap → Jupiter → Layerswap |
| 100 Robinhood USDG → Starknet USDC | 99.58 USDC |    0.44 USDG |             21.7 s | Layerswap → Jupiter → Layerswap |

These are observations, not promised prices. Quote parameters are decimal percentages: callers must
not accidentally pass `0.5` when they intend 0.5%; use explicit application units and assert the
returned minimum receive.

Layerswap's swap object stores the destination address and transactions. Its open-source EVM
depository forwards funds immediately to an owner-whitelisted solver and emits:

```solidity
Deposited(bytes32 indexed id, address indexed token, address indexed receiver, uint256 amount)
```

The `id` explicitly correlates the source deposit with an offchain order. The backend then fulfills
the destination transfer. This is useful for recovery and fatal to any claim that the provider
cannot link the two sides. There is no documented arbitrary hook data, destination attestation, or
atomic STRK20 note-open mechanism.

The API supports an optional deposit-address mode and returns ordered deposit actions containing
network, token, amount, destination/call data, and gas limit. We must treat those actions as
untrusted input: validate against the order and a narrow chain-specific schema before signing or
passing them to an anonymizer.

Sources: [API reference](https://docs.layerswap.io/api-reference/swaps/create-swap),
[deposit actions](https://docs.layerswap.io/api-reference/swaps/get-deposit-actions), and
[depository source](https://github.com/layerswap/layerswap-depository).

## Rhino.fi findings

The user-provided Rhino.fi screen shows its “easy deposit” route sending USDG on Robinhood Chain and
receiving USDC on Starknet at a selected recipient. This validates the return direction at the
current UI level. Rhino's smart-deposit-address API similarly creates a deposit address bound in
its backend to destination chain/address and refund data.

The API status/history models expose or necessarily retain deposit address, deposit chain,
destination chain/address, sender, source and destination transactions, amounts, and fees. Its
public bridge contract emits sender, `tx.origin`, token, amount, and a backend commitment ID for
some EVM deposit paths. The repository warns that direct contract interaction is unsupported and
normal use must go through Rhino's UI/API. That commitment ID is an order lookup; no source shows it
being authenticated against a STRK20 identity or atomically consumed while opening a note.

At the time of this research, two uncertainties kept Rhino as the fallback candidate:

1. the published [supported-chain list](https://docs.rhino.fi/get-started/supported-chains) does not
   yet name Robinhood despite the live UI route; and
2. current SDK/API calls require credentials, so the reverse Starknet USDC → Robinhood USDG quote,
   smart-contract source behavior, and refund flow could not be independently exercised here.

Rhino could have become preferable if its deposit-address product accepted a STRK20 helper transfer
more cleanly than Layerswap and both directions passed the same test matrix. This comparison is
retained only as historical context. Sources:
[SDA creation](https://docs.rhino.fi/api-reference/sda/depositaddresses/create-new-deposit-address),
[SDA status](https://docs.rhino.fi/api-reference/sda/depositaddresses/get-deposit-address-status),
[public contracts](https://github.com/rhinofi/contracts_public), and
[current WDK adapter](https://github.com/rhinofi/wdk-protocol-swidge-rhinofi).

## Selected MVP

Superseded on 2026-08-31. The implemented MVP uses native USDC and the official StarkWare bridge for
Starknet ↔ Arbitrum CCTP, then Relay for Arbitrum USDC ↔ Robinhood USDG. This avoids requiring
Robinhood to be a CCTP domain while retaining CCTP's canonical burn/mint semantics at the STRK20
boundary. A funded mainnet canary and the recovery/security gates below are still required.

## Adapter contract

A transport adapter should expose domain objects, never opaque “ready transactions” alone:

```ts
interface StableTransportOrder {
  provider: "relay";
  id: string;
  sourceChain: "ARBITRUM_MAINNET" | "ROBINHOOD_MAINNET";
  sourceAsset: string;
  destinationChain: "ROBINHOOD_MAINNET" | "ARBITRUM_MAINNET";
  destinationAsset: string;
  destination: string;
  refundAddress: string;
  amountIn: bigint;
  minAmountOut: bigint;
  expiresAt: number;
  depositAction: unknown;
}
```

The engine validates chain and token IDs, exact amount units, destination, refund address, expiry,
minimum receive, and a provider-specific deposit-action schema. It persists the order before the
STRK20 withdrawal or account deposit and verifies settlement from chain data.

## Failure and recovery matrix

| Failure point                               | Recovery rule                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Quote expires before source transfer        | Discard it; create a new order. No funds moved.                                                    |
| UI/app closes after order creation          | Restore the persisted order and re-check expiry; never duplicate it blindly.                       |
| Source transaction submitted, API times out | Find by transaction/order ID and inspect source chain before any retry.                            |
| Provider accepts less/more than expected    | Fail closed before deposit; after deposit, follow provider refund/manual-review policy.            |
| Destination below minimum                   | Mark policy breach/manual review; do not trade or open a note as if quote succeeded.               |
| USDG delivered to undeployed EVM account    | Safe if address derivation was verified; deploy through signed factory call.                       |
| Robinhood trade fails                       | Funds remain in account; re-quote/re-sign Pons call, or start a return order.                      |
| USDC delivered to Starknet recovery account | Resume note opening; do not create a second bridge order.                                          |
| Note opening fails                          | Funds stay in recovery account; retry with the same verified delivery and fresh Starknet fee.      |
| Provider marks refund pending               | Poll the same order; verify refund on the specified chain/address.                                 |
| Provider/operator unavailable               | Escalate with order/source transaction; the MVP has provider liveness/custody risk during transit. |

## Transport proof gates

Before mainnet product use, execute both directions at minimum and representative size and record:

- exact token contract/decimals on each chain;
- counterfactual Robinhood recipient behavior;
- fresh Starknet recovery-recipient behavior;
- source from a contract/anonymizer-compatible action, not only an EOA UI transfer;
- quote expiry and slippage units;
- fee/minimum/maximum limits;
- underpayment, overpayment, duplicate transfer, and refund behavior;
- order restore after process restart;
- independent destination balance verification; and
- provider support confirmation for production API volume.

Until those pass, the transport status is `researched`, not `production-ready`.
