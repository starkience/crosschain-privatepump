# Launchpads and liquidity

The adapter must follow the host's real asset lifecycle. Privacy does not alter its curve, reserves,
graduation threshold, AMM position, fees, or reward accounting.

## Common models

### Bonding curve then graduation

The factory creates a fixed supply and transfers sale inventory to a curve contract. Buys move quote
assets into curve reserves and tokens to the execution account; sells reverse the flow. When a sold-
supply, reserve, or market-cap threshold is reached, the launchpad pairs reserved quote assets with
remaining token inventory in an AMM and commonly locks or burns the LP position.

The predecessor PrivatePump codebase is an example: an exponential curve trades against STRK and
graduates remaining token inventory plus accumulated STRK to Ekubo. For an EVM host, the plugin
account simply calls the equivalent public buy/sell functions. Curve state and graduation are fully
public.

### Immediate AMM launch

Clanker V4 deploys the token and initializes its Uniswap V4 pool with single-sided token positions.
There is no pre-graduation curve. `clankerV4LaunchAdapter` asks the official Clanker SDK for the
current `deployToken` transaction, forces token admin, vault recipient, and creator reward roles to
the fresh account, and sends any configured builder share to the app's public builder address.

STRK20 USDC is **not** Clanker's token-side launch liquidity. Clanker's own token allocation
establishes the pool. Plank pairs new testnet launches directly with native Circle USDC and spends
the fresh account's STRK20-funded budget on a separate, confirmed creator buy immediately after
deployment. The integration omits Clanker's ETH dev-buy extension because the private balance is
USDC.

### Fair-launch hook then continuous AMM

Flaunch uses a Uniswap V4 PositionManager/hook that creates and seeds a pool, controls the initial
fair-launch schedule, handles premine/initial-price behavior, and then continues as the pool's hook.
The adapter should consume Flaunch's SDK-prepared calls rather than duplicate V4 unlock and settlement
logic. The execution account is the public participant throughout the schedule.

## Where assets live

| Stage             | Asset location                                                                      |
| ----------------- | ----------------------------------------------------------------------------------- |
| Shielded and idle | Encrypted USDC note in STRK20 on Starknet                                           |
| Bridge out        | USDC burned on Starknet, attested by Circle, minted to EVM account                  |
| Before trade      | Native USDC balance of the per-position account                                     |
| Bonding-curve buy | Quote moves to the host reserve; memecoin moves to the account                      |
| AMM buy           | Quote moves through router/pool; memecoin moves to the account                      |
| Graduation        | Host reserves and token inventory move into its AMM; plugin funds do not control LP |
| Sell/claim        | Quote or reward returns to the account                                              |
| Bridge back       | Native USDC burns on EVM and mints atomically into an STRK20 open note              |

If proceeds are ETH, WETH, USDC.e, or another quote token, the adapter must swap them to native Circle
USDC before the CCTP return. Slippage, route, approval, and swap output are public. The signed batch
must leave enough USDC for any configured relayer fee.

## Adapter review checklist

- Use the host's current official ABI/SDK and target addresses for the selected chain.
- Quote immediately before signing; include explicit minimum output/maximum input and deadline.
- Set every recipient, creator admin, reward recipient, refund address, and NFT receiver to the
  per-position account or another deliberately unlinkable address.
- Identify the phase (auction, curve, fair launch, graduated AMM) and prepare calls for that phase.
- Parse the receipt and verify the expected token/position was received by the account.
- Handle fee-on-transfer, rebasing, blacklist, and EOA-only tokens as incompatible unless tested.
- Keep venue calls and CCTP return calls in separate batches so failures cannot strand an ambiguous
  irreversible bridge operation.
