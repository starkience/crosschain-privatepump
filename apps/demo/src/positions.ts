import { getAddress, isAddress, type Address, type Hex } from "viem";

export type PrivatePositionStatus =
  | "funding"
  | "launching"
  | "buying"
  | "held"
  | "selling"
  | "returning"
  | "return-failed"
  | "buy-failed"
  | "failed"
  | "closed";

/**
 * Recovery metadata only. It intentionally contains no wallet signature,
 * private key, viewing key, or STRK20 note material.
 */
export interface PrivatePosition {
  id: string;
  kind: "launch" | "trade";
  name: string;
  symbol: string;
  token?: Address;
  accountIndex: number;
  account: Address;
  status: PrivatePositionStatus;
  usdcCommitted: string;
  tokenAmount?: string;
  launchTxHash?: string;
  buyTxHash?: string;
  sellTxHash?: string;
  lastError?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface PrivateBalanceRest {
  amount: string;
  readyAt: number;
}

const RECORD_VERSION = 1;
const STORAGE_NAMESPACE_VERSION = 2;

export type PrivateStorageScope = Hex;

export function loadPrivatePositions(
  chainId: number,
  storageScope: PrivateStorageScope,
): PrivatePosition[] {
  try {
    const value = localStorage.getItem(storageKey(chainId, storageScope));
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    if (!record(parsed) || parsed.version !== RECORD_VERSION) return [];
    if (!Array.isArray(parsed.positions)) return [];
    return parsed.positions
      .map(parsePosition)
      .filter((position): position is PrivatePosition => !!position)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  } catch {
    return [];
  }
}

export function savePrivatePositions(
  chainId: number,
  storageScope: PrivateStorageScope,
  positions: readonly PrivatePosition[],
): void {
  localStorage.setItem(
    storageKey(chainId, storageScope),
    JSON.stringify({ version: RECORD_VERSION, positions }),
  );
}

/**
 * Adds accounts rediscovered onchain without discarding richer local history.
 * Onchain custody fields win; transaction and cost details fall back to the
 * existing public recovery record when the chain scan cannot reconstruct them.
 */
export function mergeRecoveredPositions(
  existing: readonly PrivatePosition[],
  recovered: readonly PrivatePosition[],
): PrivatePosition[] {
  const next = [...existing];

  for (const discovered of recovered) {
    const matchIndex = next.findIndex(
      (candidate) => positionKey(candidate) === positionKey(discovered),
    );
    if (matchIndex === -1) {
      next.push(discovered);
      continue;
    }

    const saved = next[matchIndex]!;
    const { lastError: _lastError, ...savedWithoutError } = saved;
    next[matchIndex] = {
      ...savedWithoutError,
      ...discovered,
      id: saved.id,
      kind: discovered.kind,
      status: "held",
      usdcCommitted:
        discovered.usdcCommitted !== "0"
          ? discovered.usdcCommitted
          : saved.usdcCommitted,
      ...((discovered.launchTxHash ?? saved.launchTxHash)
        ? { launchTxHash: discovered.launchTxHash ?? saved.launchTxHash }
        : {}),
      ...((discovered.buyTxHash ?? saved.buyTxHash)
        ? { buyTxHash: discovered.buyTxHash ?? saved.buyTxHash }
        : {}),
      ...(saved.sellTxHash ? { sellTxHash: saved.sellTxHash } : {}),
      createdAt: Math.min(saved.createdAt, discovered.createdAt),
      updatedAt: Math.max(saved.updatedAt, discovered.updatedAt),
    };
  }

  return next.sort((left, right) => right.updatedAt - left.updatedAt);
}

export function loadPrivateBalanceRest(
  chainId: number,
  storageScope: PrivateStorageScope,
): PrivateBalanceRest | undefined {
  try {
    const value = localStorage.getItem(restStorageKey(chainId, storageScope));
    if (!value) return undefined;
    const parsed: unknown = JSON.parse(value);
    if (
      !record(parsed) ||
      parsed.version !== RECORD_VERSION ||
      !uintString(parsed.amount) ||
      typeof parsed.readyAt !== "number" ||
      !Number.isFinite(parsed.readyAt)
    ) {
      return undefined;
    }
    return { amount: parsed.amount, readyAt: parsed.readyAt };
  } catch {
    return undefined;
  }
}

export function savePrivateBalanceRest(
  chainId: number,
  storageScope: PrivateStorageScope,
  rest: PrivateBalanceRest,
): void {
  localStorage.setItem(
    restStorageKey(chainId, storageScope),
    JSON.stringify({ version: RECORD_VERSION, ...rest }),
  );
}

export function clearPrivateBalanceRest(
  chainId: number,
  storageScope: PrivateStorageScope,
): void {
  localStorage.removeItem(restStorageKey(chainId, storageScope));
}

/** Moves v1 address-keyed records once the identity signature is available. */
export function migratePrivateRecoveryStorage(
  chainId: number,
  rootAddress: Address,
  storageScope: PrivateStorageScope,
): void {
  migrateStorageEntry(
    legacyStorageKey(chainId, rootAddress),
    storageKey(chainId, storageScope),
  );
  migrateStorageEntry(
    legacyRestStorageKey(chainId, rootAddress),
    restStorageKey(chainId, storageScope),
  );
}

export function createPositionId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Generates a fresh derivation index and avoids every locally known position. */
export function allocateAccountIndex(
  positions: readonly PrivatePosition[],
): number {
  const used = new Set(positions.map((position) => position.accountIndex));
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const candidate = 1 + (random[0]! % 2_147_483_646);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a fresh private position account");
}

export function createLaunchSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function storageKey(
  chainId: number,
  storageScope: PrivateStorageScope,
): string {
  return `privatepons-private-positions-v${STORAGE_NAMESPACE_VERSION}:${chainId}:${normalizeStorageScope(storageScope)}`;
}

function positionKey(position: PrivatePosition): string {
  return `${position.account.toLowerCase()}:${position.token?.toLowerCase() ?? ""}`;
}

function restStorageKey(
  chainId: number,
  storageScope: PrivateStorageScope,
): string {
  return `privatepons-private-balance-rest-v${STORAGE_NAMESPACE_VERSION}:${chainId}:${normalizeStorageScope(storageScope)}`;
}

function legacyStorageKey(chainId: number, rootAddress: Address): string {
  return `plank-private-positions-v1:${chainId}:${rootAddress.toLowerCase()}`;
}

function legacyRestStorageKey(chainId: number, rootAddress: Address): string {
  return `plank-private-balance-rest-v1:${chainId}:${rootAddress.toLowerCase()}`;
}

function migrateStorageEntry(legacyKey: string, nextKey: string): void {
  const legacy = localStorage.getItem(legacyKey);
  if (legacy === null) return;
  if (localStorage.getItem(nextKey) === null) {
    localStorage.setItem(nextKey, legacy);
  }
  localStorage.removeItem(legacyKey);
}

function normalizeStorageScope(value: PrivateStorageScope): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("private recovery storage scope must be 32-byte hex");
  }
  return value.toLowerCase();
}

function parsePosition(value: unknown): PrivatePosition | undefined {
  if (!record(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    (value.kind !== "launch" && value.kind !== "trade") ||
    typeof value.name !== "string" ||
    typeof value.symbol !== "string" ||
    !Number.isSafeInteger(value.accountIndex) ||
    Number(value.accountIndex) < 0 ||
    typeof value.account !== "string" ||
    !isAddress(value.account, { strict: false }) ||
    !positionStatus(value.status) ||
    !uintString(value.usdcCommitted) ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    return undefined;
  }
  if (
    value.token !== undefined &&
    (typeof value.token !== "string" ||
      !isAddress(value.token, { strict: false }))
  ) {
    return undefined;
  }
  if (value.tokenAmount !== undefined && !uintString(value.tokenAmount)) {
    return undefined;
  }
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    symbol: value.symbol,
    ...(value.token ? { token: getAddress(value.token.toLowerCase()) } : {}),
    accountIndex: Number(value.accountIndex),
    account: getAddress(value.account.toLowerCase()),
    status: value.status,
    usdcCommitted: value.usdcCommitted,
    ...(value.tokenAmount ? { tokenAmount: value.tokenAmount } : {}),
    ...(text(value.launchTxHash) ? { launchTxHash: value.launchTxHash } : {}),
    ...(text(value.buyTxHash) ? { buyTxHash: value.buyTxHash } : {}),
    ...(text(value.sellTxHash) ? { sellTxHash: value.sellTxHash } : {}),
    ...(text(value.lastError) ? { lastError: value.lastError } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function positionStatus(value: unknown): value is PrivatePositionStatus {
  return [
    "funding",
    "launching",
    "buying",
    "held",
    "selling",
    "returning",
    "return-failed",
    "buy-failed",
    "failed",
    "closed",
  ].includes(value as PrivatePositionStatus);
}

function uintString(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
