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

`ALLOWED_TARGETS` is a comma-separated list containing the host launchpad, token contracts, swap
router, Circle USDC, and Circle TokenMessenger used by the enabled flows. The relayer fails to start
without it. `ALLOW_UNSAFE_ANY_TARGETS=true` disables this protection and is intended only for
isolated local development. Set `RELAYER_FEE_TOKEN`, `RELAYER_FEE_AMOUNT`, and optionally
`RELAYER_FEE_RECIPIENT` to collect a signed USDC fee. Request bodies, signatures, and derived account
addresses must not be logged because a single operator observing both identity and venue traffic can
weaken unlinkability.

The HTTP surface is `POST /v1/relay`; `GET /healthz` is the only unauthenticated read endpoint. Add
rate limiting and access control at the deployment edge.
