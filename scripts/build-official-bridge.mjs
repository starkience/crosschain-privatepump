import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const outputDirectory = resolve(
  process.argv[2] ?? join(repositoryRoot, "apps/demo/public/vendor"),
);

const pins = JSON.parse(
  await readFile(join(repositoryRoot, "config/official-bridge.json"), "utf8"),
);
const { sdk, bridge, proverTransport, requiredExports } = pins;
validatePins(pins);

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "private-launchpad-official-bridge-"),
);

try {
  const esbuild = join(
    repositoryRoot,
    "node_modules/.pnpm/node_modules/.bin/esbuild",
  );
  await requireExecutable(
    esbuild,
    "Run pnpm install before building the official bridge source.",
  );
  await mkdir(outputDirectory, { recursive: true });

  const sdkRepository = join(temporaryDirectory, "starknet-privacy");
  const bridgeRepository = join(temporaryDirectory, "privacy-bridge");
  const artifactsDirectory = join(temporaryDirectory, "artifacts");
  await mkdir(artifactsDirectory);

  step("Fetching pinned Starknet Privacy SDK source");
  checkout(sdk.repository, sdk.commit, sdkRepository);
  const sdkDirectory = join(sdkRepository, "sdk");
  run(
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    sdkDirectory,
  );
  run("npm", ["run", "build"], sdkDirectory);
  run(
    "npm",
    ["pack", "--silent", "--pack-destination", artifactsDirectory],
    sdkDirectory,
  );
  const sdkTarball = await singleTarball(
    artifactsDirectory,
    "starkware-libs-starknet-privacy-sdk-",
  );

  step("Fetching pinned Starknet Privacy Bridge source");
  checkout(bridge.repository, bridge.commit, bridgeRepository);
  await overrideBridgeSdk(bridgeRepository, sdkTarball);
  await patchBridgeProverTransport(bridgeRepository, proverTransport);
  run(
    "pnpm",
    ["install", "--no-frozen-lockfile", "--ignore-scripts"],
    bridgeRepository,
  );
  run(
    "pnpm",
    ["--filter", "@starkware-libs/starknet-privacy-bridge", "build"],
    bridgeRepository,
  );

  const bridgeEntry = join(
    bridgeRepository,
    "packages/bridge-core/dist/index.js",
  );
  await validateModule(bridgeEntry);

  step("Bundling the official browser runtime");
  const versionedFilename = `privacy-bridge-v${bridge.version}.mjs`;
  const bundledModule = join(outputDirectory, versionedFilename);
  run(
    esbuild,
    [
      bridgeEntry,
      "--bundle",
      "--format=esm",
      "--platform=browser",
      "--target=es2022",
      "--minify",
      "--legal-comments=eof",
      '--define:process.env.NODE_ENV="production"',
      `--outfile=${bundledModule}`,
    ],
    bridgeRepository,
  );
  await validateModule(bundledModule);

  const manifest = {
    schemaVersion: 1,
    module: versionedFilename,
    sha256: await sha256(bundledModule),
    requiredExports,
    sdk,
    bridge,
    proverTransport,
    builder: {
      esbuild: output(esbuild, ["--version"], repositoryRoot),
      node: process.version,
    },
  };
  await writeFile(
    join(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  step(`Validated ${requiredExports.join(", ")}`);
  process.stdout.write(
    `${JSON.stringify({ outputDirectory, ...manifest }, null, 2)}\n`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function step(message) {
  process.stderr.write(`\n[official-bridge] ${message}\n`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function output(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result.stdout.trim();
}

function checkout(repository, commit, directory) {
  run("git", ["init", "--quiet", directory], repositoryRoot);
  run(
    "git",
    ["-C", directory, "remote", "add", "origin", repository],
    repositoryRoot,
  );
  run(
    "git",
    ["-C", directory, "fetch", "--quiet", "--depth", "1", "origin", commit],
    repositoryRoot,
  );
  run(
    "git",
    ["-C", directory, "checkout", "--quiet", "--detach", "FETCH_HEAD"],
    repositoryRoot,
  );
  const actual = output(
    "git",
    ["-C", directory, "rev-parse", "HEAD"],
    repositoryRoot,
  );
  if (actual !== commit) {
    throw new Error(
      `checkout mismatch: expected ${commit}, received ${actual}`,
    );
  }
}

async function overrideBridgeSdk(bridgeRepository, sdkTarball) {
  const manifestPath = join(bridgeRepository, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.pnpm ??= {};
  manifest.pnpm.overrides ??= {};
  manifest.pnpm.overrides["@starkware-libs/starknet-privacy-sdk"] =
    `file:${sdkTarball}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function patchBridgeProverTransport(bridgeRepository, transport) {
  const poolClientPath = join(
    bridgeRepository,
    "packages/bridge-core/src/core/poolClient.ts",
  );
  const source = await readFile(poolClientPath, "utf8");
  const original = `    provingProvider: {
      url: config.proverUrl,
      chainId: config.chainId as constants.StarknetChainId,
    },`;
  const replacement = `    provingProvider: {
      url: config.proverUrl,
      chainId: config.chainId as constants.StarknetChainId,
      // PrivatePons supports one long synchronous StarkWare request as well as
      // Starkscan's asynchronous jobs, which surface as retryable HTTP 503s.
      // The client deadline remains below the Vercel function ceiling.
      requestTimeoutMs: ${transport.requestTimeoutMs},
      retry: {
        maxRetries: ${transport.maxRetries},
        baseDelayMs: ${transport.baseDelayMs},
      },
    },`;
  if (source.split(original).length !== 2) {
    throw new Error(
      "pinned privacy bridge poolClient.ts no longer matches the reviewed prover transport patch",
    );
  }
  await writeFile(poolClientPath, source.replace(original, replacement));
}

async function singleTarball(directory, prefix) {
  const matches = (await readdir(directory)).filter(
    (name) => name.startsWith(prefix) && name.endsWith(".tgz"),
  );
  if (matches.length !== 1) {
    throw new Error(`expected one ${prefix} tarball, found ${matches.length}`);
  }
  return join(directory, matches[0]);
}

async function validateModule(modulePath) {
  const cacheBust = `build=${Date.now()}-${Math.random()}`;
  const module = await import(`${pathToFileURL(modulePath).href}?${cacheBust}`);
  for (const name of requiredExports) {
    if (typeof module[name] !== "function") {
      throw new Error(`official bridge module is missing function ${name}`);
    }
  }
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function requireExecutable(path, help) {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(help);
  }
}

function validatePins(value) {
  const expectedExports = [
    "bridgeEnvFromRecord",
    "initBridgeConfig",
    "getActiveConfig",
    "readUndepositedResidual",
    "deriveAccountNonce",
    "derivePolygonEoa",
    "fetchForwardMaxFee",
    "bridgeOut",
    "sendPrivateToStarknet",
    "moveIntoPool",
    "cashOut",
    "fundAccountFromPool",
    "returnToPool",
  ];
  const validSource = (source) =>
    source &&
    typeof source.repository === "string" &&
    /^https:\/\/github\.com\/starkware-libs\/[a-z0-9-]+\.git$/.test(
      source.repository,
    ) &&
    /^[0-9a-f]{40}$/.test(source.commit) &&
    /^[0-9A-Za-z.-]+$/.test(source.version);
  if (
    value.schemaVersion !== 1 ||
    !validSource(value.sdk) ||
    !validSource(value.bridge) ||
    !value.proverTransport ||
    !Number.isSafeInteger(value.proverTransport.requestTimeoutMs) ||
    value.proverTransport.requestTimeoutMs < 21_000 ||
    !Number.isSafeInteger(value.proverTransport.maxRetries) ||
    value.proverTransport.maxRetries < 4 ||
    !Number.isSafeInteger(value.proverTransport.baseDelayMs) ||
    value.proverTransport.baseDelayMs <= 0 ||
    JSON.stringify(value.requiredExports) !== JSON.stringify(expectedExports)
  ) {
    throw new Error("config/official-bridge.json is invalid");
  }
}
