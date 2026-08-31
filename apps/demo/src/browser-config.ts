/**
 * Public browser routing and canonical onchain configuration.
 *
 * This object intentionally contains no credentials or upstream provider URLs.
 * Every network request uses a same-origin route backed by a server-side proxy.
 */
export const PONS_BROWSER_CONFIG = {
  VITE_NETWORK: "mainnet",
  VITE_CCTP_FAST: "true",
  VITE_CCTP_DEFAULT_DEST_CHAIN_ID: "42161",
  VITE_OZ_ACCOUNT_CLASS_HASH_MAINNET:
    "0x5b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564",
  VITE_PRIVATE_LAUNCHPAD_FACTORY: "0x2f04549436Aeb3693E849E6C8121CA901edF7Ce4",
  VITE_ROBINHOOD_RPC_URL: "/robinhood-rpc",
  VITE_ARBITRUM_RPC_URL: "/arbitrum-rpc",
  VITE_RELAY_BRIDGE_URL: "/api/relay",
  VITE_PRIVATE_LAUNCHPAD_RELAYER_URL: "/api/private-launchpad/v1/relay",
  VITE_AVNU_PAYMASTER_URL: "/api/avnu",
  // The official bridge requires a non-empty value. The real AVNU key is
  // attached only by the server proxy and is never sent to the browser.
  VITE_AVNU_PAYMASTER_API_KEY: "same-origin-proxy",
} as const satisfies Readonly<Record<string, string>>;
