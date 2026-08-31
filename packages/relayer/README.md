# Private launchpad relayer

This service submits `PrivateLaunchpadAccountFactory.deployAndExecute` transactions. It never holds
the private execution-account owner key: the browser signs an EIP-712 batch, and the account checks
that signature onchain. The relayer pays native gas and can charge a signer-approved ERC-20 fee.

Required environment variables:

- `CHAIN_ID`
- `RPC_URL`
- `FACTORY_ADDRESS`
- `RELAYER_PRIVATE_KEY`
- `ALLOWED_TARGETS`

Private Clanker trading additionally uses:

- `USDC_ADDRESS`
- `UNISWAP_API_KEY`
- `UNISWAP_PROXY_ADDRESS`
- `ALLOW_UNISWAP_PROXY_APPROVALS=true`

`ALLOWED_TARGETS` is a comma-separated list containing the host launchpad, token contracts, swap
router, Circle USDC, and Circle TokenMessenger used by the enabled flows. The relayer fails to start
without it. `ALLOW_UNSAFE_ANY_TARGETS=true` disables this protection and is intended only for
isolated local development. Set `RELAYER_FEE_TOKEN`, `RELAYER_FEE_AMOUNT`, and optionally
`RELAYER_FEE_RECIPIENT` to collect a signed USDC fee. Request bodies, signatures, and derived account
addresses must not be logged because a single operator observing both identity and venue traffic can
weaken unlinkability.

The bounded proxy-approval exception does not enable arbitrary token calls. It accepts only a
zero-value ERC-20 `approve(UNISWAP_PROXY_ADDRESS, amount)` call on a dynamic token target; the proxy
itself must still be in `ALLOWED_TARGETS`. The quote service also verifies the Uniswap AMM route,
input/output assets, account sender/recipient, approval spender, chain, and minimum output before
returning calls to the browser.

The HTTP surface is `POST /v1/relay`, `POST /v1/clanker/quote`, and `GET /healthz`. Add rate limiting
and access control at the deployment edge. Keep `UNISWAP_API_KEY` server-side.

The Robinhood `PONS_V2_POLICY=true` profile also requires `RELAY_API_KEY` and an HTTPS
`RELAY_API_URL`. A sell-return batch must carry the 32-byte Relay request ID. Before simulation or
broadcast, the relayer resolves that request through Relay's authenticated Requests API and checks
the R2 user, refund owner, strict deposit address, input/output chain and currency, exact input
amount, executable status, and maximum quote age. Configure the latter with
`RELAY_RETURN_MAX_QUOTE_AGE_SECONDS` (default `900`).
