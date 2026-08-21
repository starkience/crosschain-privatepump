# Security

This repository is an unaudited testnet prototype. Do not use it to custody mainnet funds.

Report suspected vulnerabilities privately through GitHub's security-advisory flow. Do not include
identity signatures, viewing keys, derived private keys, RPC credentials, or live transaction
payloads in an issue.

Before production use, independently review the Solidity account and factory, relayer policy and
operations, browser key lifecycle, selected privacy-bridge and STRK20 releases, every host adapter,
and the end-to-end correlation threat model. Pin all dependencies and deployed addresses. Run the
transaction-level gates in [docs/deployment.md](docs/deployment.md) again against the exact release.

The account intentionally authorizes arbitrary `CALL` batches. Treat the relayer target allowlist,
the host adapter's quote and recipient validation, and the user's EIP-712 confirmation as separate
security boundaries. Never allow `delegatecall`, never reuse a session index for unrelated
positions, and never log the root identity signature or derived owner key.
