import {
  createStarkwarePrivacyBridgeEngine,
  type PrivacyBridgeEngine,
  type StarkwarePrivacyBridgeExports,
} from "@private-launchpad/sdk";
import pins from "../../../config/official-bridge.json";

export const OFFICIAL_BRIDGE_MODULE_URL = "/vendor/privacy-bridge-v0.1.22.mjs";
export const OFFICIAL_BRIDGE_MANIFEST_URL = "/vendor/manifest.json";

const expectedPins = {
  sdk: pins.sdk.commit,
  bridge: pins.bridge.commit,
};

interface OfficialBridgeManifest {
  schemaVersion: 1;
  module: string;
  sha256: string;
  sdk: { commit: string };
  bridge: { commit: string };
}

export function validateOfficialBridgeManifest(
  value: unknown,
): OfficialBridgeManifest {
  if (!value || typeof value !== "object") {
    throw new Error("official privacy bridge manifest did not load");
  }
  const manifest = value as Partial<OfficialBridgeManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.module !== OFFICIAL_BRIDGE_MODULE_URL.split("/").at(-1) ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256 ?? "") ||
    manifest.sdk?.commit !== expectedPins.sdk ||
    manifest.bridge?.commit !== expectedPins.bridge
  ) {
    throw new Error(
      "official privacy bridge manifest does not match pinned source",
    );
  }
  return manifest as OfficialBridgeManifest;
}

export function validateOfficialBridgeModule(
  value: unknown,
): StarkwarePrivacyBridgeExports {
  if (!value || typeof value !== "object") {
    throw new Error("official privacy bridge module did not load");
  }
  const module = value as Record<string, unknown>;
  for (const name of [
    "derivePolygonEoa",
    "fundAccountFromPool",
    "returnToPool",
  ] as const) {
    if (typeof module[name] !== "function") {
      throw new Error(`official privacy bridge is missing ${name}`);
    }
  }
  return module as unknown as StarkwarePrivacyBridgeExports;
}

export async function loadOfficialBridgeEngine(
  manifestUrl = OFFICIAL_BRIDGE_MANIFEST_URL,
): Promise<PrivacyBridgeEngine> {
  const manifestResponse = await fetch(manifestUrl, { cache: "no-store" });
  if (!manifestResponse.ok) {
    throw new Error(
      `official privacy bridge manifest returned ${manifestResponse.status}`,
    );
  }
  const manifest = validateOfficialBridgeManifest(
    await manifestResponse.json(),
  );
  const moduleUrl = new URL(manifest.module, manifestResponse.url).href;
  const moduleResponse = await fetch(moduleUrl, { cache: "no-store" });
  if (!moduleResponse.ok) {
    throw new Error(
      `official privacy bridge module returned ${moduleResponse.status}`,
    );
  }
  const source = await moduleResponse.arrayBuffer();
  if ((await sha256(source)) !== manifest.sha256) {
    throw new Error("official privacy bridge module failed its SHA-256 check");
  }

  const objectUrl = URL.createObjectURL(
    new Blob([source], { type: "text/javascript" }),
  );
  try {
    const module: unknown = await import(/* @vite-ignore */ objectUrl);
    return createStarkwarePrivacyBridgeEngine(
      validateOfficialBridgeModule(module),
    );
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function sha256(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
