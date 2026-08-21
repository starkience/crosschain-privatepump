# Sepolia deployment

## Network constants

| Component                          | Network          | Address / value                                                      |
| ---------------------------------- | ---------------- | -------------------------------------------------------------------- |
| STRK20 privacy pool v2             | Starknet Sepolia | `0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91` |
| Outbound privacy-bridge anonymizer | Starknet Sepolia | `0x05b85f2ae4d47c1e661533d5832fe3e4afd4c6a9b52e54b7f873a00c9b285f4e` |
| Inbound privacy-bridge anonymizer  | Starknet Sepolia | `0x00d2a07c657d8c70f6eeddb7c8125e39b0955a40a608f63ca8a88d3ebbf72117` |
| Native Circle USDC                 | Starknet Sepolia | `0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343` |
| CCTP TokenMessengerV2              | Starknet Sepolia | `0x04bdde1e09a4b09a2f95d893d94a967b7717eb85a3f6deca8c080ee01fbc3370` |
| CCTP MessageTransmitterV2          | Starknet Sepolia | `0x04db7926c64f1f32a840f3fa95cb551f3801a3600bae87af87807a54dce12fe8` |
| Base Sepolia chain / CCTP domain   | Base Sepolia     | `84532` / `6`                                                        |
| Native Circle USDC                 | Base Sepolia     | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`                         |
| CCTP TokenMessengerV2              | Base Sepolia     | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`                         |

The Starknet contracts are canonical upstream deployments and are consumed, not redeployed. Verify
their class hashes and the bridge release immediately before a public launch.

## Deploy the EVM factory

Create an untracked `.env.local` from `.env.example`. The Alchemy key may be used in both RPC URLs.
Create a dedicated encrypted Foundry keystore and fund its address with Base Sepolia ETH; do not put
the deployer key in an environment file.

```sh
cast wallet new ~/.foundry/keystores privatepump-sepolia
cast wallet address --account privatepump-sepolia

set -a
. ./.env.local
set +a
forge script evm/script/Deploy.s.sol:Deploy \
  --root evm \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account privatepump-sepolia \
  --broadcast
```

The prepared testnet deployer for this deployment is recorded in
`deployments/base-sepolia.json`. At the recorded snapshot its Base Sepolia balance is zero, so
broadcasting is intentionally blocked until it is faucet-funded.

Record the transaction, factory address, bytecode hash, compiler version, and block number in
`deployments/base-sepolia.json`. Verify the source once a BaseScan API key is configured.

## Run the relayer

Fund a separate relayer key with Base Sepolia ETH. Set `CHAIN_ID=84532`, `RPC_URL`,
`FACTORY_ADDRESS`, and `RELAYER_PRIVATE_KEY`. During a sponsored test set the fee to zero. Before a
public deployment, set a USDC fee and an `ALLOWED_TARGETS` list covering only approved hosts, token
contracts, routers, USDC, and Circle TokenMessenger.

## End-to-end gate

1. Initialize upstream bridge-core on `testnet` with Starknet RPC, prover, indexer, an eligible OZ
   account class hash, and AVNU paymaster configuration.
2. Derive session index `0`; confirm the SDK prediction equals the factory's `computeAddress`.
3. Shield test USDC and wait until its note is mature and visible at the proving base.
4. Bridge a common denomination to Base Sepolia and confirm Circle mints to the counterfactual
   account.
5. Relay a host testnet call and verify the factory deploys the predicted account, nonce increments,
   and the asset is received.
6. Sell/convert to native USDC, relay the CCTP return, obtain the attestation, and verify the inbound
   anonymizer creates a spendable STRK20 note after maturity.
7. Confirm no root address, signature, viewing key, derived private key, or exact activity payload is
   present in browser/server logs or analytics.

Deployment is incomplete until all seven gates have transaction-level evidence.
