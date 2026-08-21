# Privacy and threat model

## Exact claim

The plugin hides the user's connected/root wallet from an EVM launchpad behind a fresh, per-position
execution account funded from the STRK20 anonymity set. It does not hide the execution account or
its onchain behavior.

| Data                                                                             | Visibility                                                  |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| STRK20 note owner, internal sender/recipient, token, amount, spent-note relation | Hidden inside the pool                                      |
| Connected/root EVM wallet to launchpad-account link                              | Not present onchain when the prescribed flow is followed    |
| Launchpad execution account                                                      | Public                                                      |
| Host, token, function, calldata, value, amounts, events, price impact            | Public                                                      |
| Account actions reused under one index                                           | Publicly linkable                                           |
| STRK20 deposits and withdrawals                                                  | Public address, token, amount, timing                       |
| CCTP burns/mints                                                                 | Public source/destination domain, recipient, amount, timing |
| Open-note token and amount used by private DeFi                                  | Public                                                      |
| Pool nullifiers                                                                  | Public but unlinkable without a viewing key                 |
| User activity to the STRK20 auditor                                              | Selectively disclosable by protocol design                  |

## Correlation risks

- Distinctive amounts and rapid shield → bridge → trade or trade → return sequences reduce the
  anonymity set. Default to common funding buckets and add user-controlled timing separation.
- CCTP publicly links the Starknet burn to the EVM account it funds. The hidden fact is which pool
  user controls that account, not that the account came from the pool.
- Reusing one account links every token, trade, launch, reward, and return made by that account.
- A creator can self-identify through metadata, social links, reward recipients, vault admins, salt
  choices, or immediate transfers to a known wallet even if the deploying account is fresh.
- An ETH top-up from a known wallet directly links the account. Use relayed calls and signer-approved
  USDC fees.
- Exact trade amounts can correlate with bridge denominations. Bridge a bucket, wait, and trade a
  non-identical sub-amount while retaining change when the product can tolerate it.

## Observers and trust

- STRK20's prover and discovery services process private requests. Use HTTPS and the upstream OHTTP
  configuration with pinned keys in production.
- The STRK20 auditor can decrypt a targeted user's activity but cannot spend funds. Deposit screening
  is mandatory and enforced onchain.
- Circle observes CCTP transfers and publishes attestations.
- EVM and Starknet RPC providers see client request timing and addresses.
- The relayer sees signed execution calls, the execution account, and client IP unless requests are
  proxied. It must never receive or log the root identity signature, viewing key, or derived owner
  private key.
- A launchpad or its frontend may collect IP/device analytics. Embedding the plugin in the host UI can
  recreate an offchain root-wallet ↔ execution-account join unless telemetry is isolated.

No single operator should receive both the root-wallet identity session and the venue execution
request. Do not send raw addresses, transaction hashes, exact amounts, or signatures to analytics.

## STRK20 limitations that affect UX

- Both parties must register viewing keys before private transfers. This plugin's EVM account path
  does not require an EVM recipient to register, but any later in-pool transfer does.
- Newly created notes mature after roughly ten blocks before spending.
- A shield requires approval followed by deposit and therefore normally two wallet prompts.
- One pool transaction may contain at most one external/compute invoke.
- Proofs must be built against sufficiently aged state and submitted within the pool's configured
  proof-validity window.
- The current SDK and wallet surfaces are fast-moving release candidates; pin and revalidate all
  versions and deployed addresses before release.
