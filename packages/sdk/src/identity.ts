/// Builds the stable, app-scoped message whose wallet signature feeds StarkWare's
/// domain-separated Starknet, viewing-key, and EVM-owner derivations. Changing the
/// app id or version changes every derived account and can orphan existing funds.
export function createPrivateLaunchpadIdentityMessage(appId: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(appId)) {
    throw new Error(
      "appId must be a lowercase DNS-style slug of at most 63 characters",
    );
  }
  return [
    "Crosschain Private Launchpad — derive privacy keys",
    "Version: 1",
    `Application: ${appId}`,
    "",
    "This signature does not authorize a blockchain transaction or transfer.",
  ].join("\n");
}
