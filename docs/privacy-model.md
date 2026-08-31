# Privacy and threat model

## Exact claim

The plugin hides the user's connected/root wallet from an EVM launchpad behind a fresh, per-position
execution account funded from the STRK20 anonymity set. It does not hide the execution account or
its onchain behavior. "Hides" here means that no R1 → R2 ownership edge is written onchain by the
prescribed flow. It does not mean that the browser, app operator, Relay, Circle, RPC providers, or
an observer correlating amount and timing cannot infer or record the relationship.

| Data                                                                             | Visibility                                                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| STRK20 note owner, internal sender/recipient, token, amount, spent-note relation | Hidden inside the pool                                                                                |
| Connected/root EVM wallet to launchpad-account link                              | Not present onchain when the prescribed flow is followed                                              |
| Launchpad execution account                                                      | Public                                                                                                |
| Host, token, function, calldata, value, amounts, events, price impact            | Public                                                                                                |
| Account actions reused under one index                                           | Publicly linkable                                                                                     |
| STRK20 deposits and withdrawals                                                  | Public address, token, amount, timing                                                                 |
| CCTP burns/mints                                                                 | Public source/destination domain, recipient, amount, timing                                           |
| Relay orders                                                                     | Relay sees both endpoints, assets, amounts, refund data, and timing                                   |
| Open-note token and amount used by private DeFi                                  | Public                                                                                                |
| Pool nullifiers                                                                  | Public but unlinkable without a viewing key                                                           |
| User activity to the STRK20 auditor                                              | Selectively disclosable by protocol design                                                            |
| Browser recovery records                                                         | Local position addresses, amounts, and transaction history under a signature-derived opaque namespace |

## R1 and R2 separation

R1 and R2 must never transfer to one another, fund one another's gas, share an execution-account
index, or appear together in telemetry. With the implemented route, R1 deposits through Relay to a
domain-separated Arbitrum account A1 and then through CCTP into STRK20. A private withdrawal uses
CCTP to a Relay deposit address, and Relay funds R2. The pool is the onchain separation boundary.

That is sufficient to avoid a deterministic **onchain** R1 ↔ R2 link. It is not sufficient for
perfect anonymity:

- Relay sees R1 ↔ A1 on deposit and a Relay deposit address ↔ R2 on funding. Reusing the same
  service, IP/session, exact amount, or a tight timing window can correlate those orders.
- The application prepares both flows in one browser session. Its same-origin proxies and hosting
  provider can correlate requests unless production traffic separation and log minimization are
  enforced.
- Position, balance-rest, and in-flight funding records now use an opaque namespace derived from the
  app-scoped identity signature; legacy keys containing the connected wallet are migrated and
  deleted. The records still contain public R2/account metadata. Same-origin code observing the live
  wallet session, transaction-monitor records, browser compromise, or a shared device can therefore
  reconstruct the relationship even though the durable recovery key no longer contains R1.
- The identity signature deterministically derives all route keys. It stays memory-only, but its
  compromise reconstructs the relationship.

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
- The same Relay provider handles the public deposit, private funding, and sell-return edges. Relay
  is not given the root derivation signature, but service metadata and amount/timing analysis can
  join otherwise independent addresses.

The reference UI limits funded launches to common 25, 50, 100, and 250 USDC buckets and marks each
new deposit as unavailable for launch during a randomized 2–5 minute demo buffer. Each launch then
derives a new Base execution account. These defaults reduce simple amount-and-time matching; they do
not guarantee anonymity; production should use a longer, policy-driven interval. A production balance service must persist note maturity and the randomized
release time so refreshing or changing devices cannot bypass the buffer.

## Observers and trust

- STRK20's prover and discovery services process private requests. Use HTTPS and the upstream OHTTP
  configuration with pinned keys in production.
- The STRK20 auditor can decrypt a targeted user's activity but cannot spend funds. Deposit screening
  is mandatory and enforced onchain.
- Circle observes CCTP transfers and publishes attestations.
- Relay observes both endpoints and refund data for each order. It is trusted for routing and
  liveness, and must not be described as an anonymity provider.
- EVM and Starknet RPC providers see client request timing and addresses.
- The relayer sees signed execution calls, the execution account, and client IP unless requests are
  proxied. Structured logs omit the execution account and account index. It must never receive or
  log the root identity signature, viewing key, derived owner private key, or request body.
- A launchpad or its frontend may collect IP/device analytics. Embedding the plugin in the host UI can
  recreate an offchain root-wallet ↔ execution-account join unless telemetry is isolated.
- The browser persists public recovery metadata so interrupted transfers and positions can be
  resumed. This does not grant spend authority, but it does disclose the local account graph to
  anyone who can read site storage.

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
