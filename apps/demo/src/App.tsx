import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CoinsIcon } from "@phosphor-icons/react/dist/csr/Coins";
import { CurrencyCircleDollarIcon } from "@phosphor-icons/react/dist/csr/CurrencyCircleDollar";
import { GiftIcon } from "@phosphor-icons/react/dist/csr/Gift";
import { GlobeSimpleIcon } from "@phosphor-icons/react/dist/csr/GlobeSimple";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { LockKeyIcon } from "@phosphor-icons/react/dist/csr/LockKey";
import { ListDashesIcon } from "@phosphor-icons/react/dist/csr/ListDashes";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { RocketLaunchIcon } from "@phosphor-icons/react/dist/csr/RocketLaunch";
import { SealPercentIcon } from "@phosphor-icons/react/dist/csr/SealPercent";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { ShoppingCartSimpleIcon } from "@phosphor-icons/react/dist/csr/ShoppingCartSimple";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { VaultIcon } from "@phosphor-icons/react/dist/csr/Vault";
import { WalletIcon } from "@phosphor-icons/react/dist/csr/Wallet";
import {
  RelayerRejectedError,
  type BridgeFundResult,
  type BridgeReturnResult,
  type PrivateLaunchpadSession,
} from "@private-launchpad/sdk";
import type {
  LaunchDraft,
  LaunchpadRuntime,
  PreparedIdentity,
  TradeDraft,
  TradeExecution,
} from "./runtime.js";
import {
  allocateAccountIndex,
  clearPrivateBalanceRest,
  createLaunchSalt,
  createPositionId,
  loadPrivateBalanceRest,
  loadPrivatePositions,
  mergeRecoveredPositions,
  migratePrivateRecoveryStorage,
  savePrivateBalanceRest,
  savePrivatePositions,
  type PrivatePosition,
  type PrivateStorageScope,
} from "./positions.js";

interface AppProps {
  runtime: LaunchpadRuntime;
}

type PortfolioSnapshotStatus = "loading" | "verified" | "empty" | "unavailable";

interface PortfolioSnapshot {
  status: PortfolioSnapshotStatus;
  tokenBalance?: bigint;
  estimatedUsdg?: bigint;
  minimumUsdg?: bigint;
  checkedAt?: number;
  error?: string;
}

type PositionRecoveryState =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "done"; recovered: number; checkedAt: number }
  | { status: "error"; message: string };

type Workspace = "explore" | "launch" | "trade" | "positions";
type OperationStage =
  "idle" | "identity" | "funding" | "executing" | "returning" | "complete";

const USDC_SCALE = 1_000_000n;
const COMMON_USDC_AMOUNTS = [25, 50, 100, 250] as const;
const MINIMUM_PRIVATE_REST_MINUTES = 2;
const RANDOM_PRIVATE_REST_MINUTES = 4;
const OFFICIAL_PONS_ORIGIN = "https://robinhood.ponslaunchpad.com";
const USDG_ICON_URL =
  "https://424565.fs1.hubspotusercontent-na1.net/hubfs/424565/GDN_USDG_Token_32x32.png";
const demoToken =
  "0x4b07b7d32d3d5e1a16f33189f10f8f2b608a4b07" as PrivateLaunchpadSession["account"];

interface PonsMarket {
  name: string;
  symbol: string;
  token: PrivateLaunchpadSession["account"];
  description: string;
  marketCap: string;
  volume: string;
  age: string;
  version: "V1" | "V2";
  glyph: string;
  art: string;
  progress: number;
  live?: boolean;
  privateTrading?: boolean;
  imageSources?: readonly string[];
}

interface GraduatedMarket {
  token: string;
  deployer: string;
  name: string;
  symbol: string;
  logo: string;
  marketCapUsd: number;
  realMcapUsd?: number | null;
  graduatedAt?: string | null;
  launchedAt?: string | null;
  version?: string | null;
}

const LIVE_PONS_MARKETS: readonly PonsMarket[] = [
  {
    name: "PonsDonate",
    symbol: "DONATE",
    token: "0xD4f1C2Fb5eD5Ab256d41fefeC00fd40Dce6B7c86",
    description: "A recent community-created Pons V2 market.",
    marketCap: "Live curve",
    volume: "USDG pair",
    age: "recent",
    version: "V2",
    glyph: "P",
    art: "acid",
    progress: 18,
    live: true,
    imageSources: ponsAssetUrls(
      "ipfs://bafkreibnqkvmyfznrhml2uw7mxfqbjyhdm6g4l43zmn2wythc7qbya4ybm",
    ),
  },
  {
    name: "$30 and a dream",
    symbol: "DREAM",
    token: "0x8337FA83C4fE298eF34e727aAfD2080F5515D8E2",
    description: "A Pons V2 token paired with USDG on Robinhood Chain.",
    marketCap: "Live curve",
    volume: "USDG pair",
    age: "recent",
    version: "V2",
    glyph: "30",
    art: "sunset",
    progress: 36,
    live: true,
    imageSources: ponsAssetUrls(
      "ipfs://bafybeiezsmhtceo7yvf4ke2wnlt5zeg2j7kvfhr2xrld6fpf5tczgr7s3m",
    ),
  },
  {
    name: "Harvest",
    symbol: "HARVEST",
    token: "0x1AD0E8537128c1A17f7998f3457Fe92Fd8d226e7",
    description: "A recent Pons V2 market discovered onchain.",
    marketCap: "Live curve",
    volume: "USDG pair",
    age: "recent",
    version: "V2",
    glyph: "H",
    art: "harvest",
    progress: 62,
    live: true,
    imageSources: ponsAssetUrls(
      "ipfs://QmSLZB8BcwWzNvXRnGjZpdfGtyHJWD6hruFmPHCduUTmGJ",
    ),
  },
];

const FALLBACK_GRADUATED_MARKETS: readonly GraduatedMarket[] = [
  {
    token: "0x39dBED3a2bd333467115dE45665cC57F813C4571",
    deployer: "0xB9F5f4Ea1AF1F5d3678470eb98e8FBdcadEb24b0",
    name: "Pons",
    symbol: "PONS",
    logo: "ipfs://bafybeiehcgbqotmir6tqi76eorpihucphlry53cx3mmnxgmqjjxpwherwq",
    marketCapUsd: 134_783_137,
    realMcapUsd: 95_914_358,
    graduatedAt: "2026-07-13T14:08:00.000Z",
  },
  {
    token: "0x7FE995a80075dF3Dc8Ae11A9b82c7FE4202CD87f",
    deployer: "0x934e92E1C82020fc4e1Ee55712C6d9fb19C6782a",
    name: "Thinking Cat",
    symbol: "HMM",
    logo: "https://gateway.pinata.cloud/ipfs/Qmb8rr5dz47bBRWq3QfPtnonnzYu6Bn7hJpqBCqg8jj9gs",
    marketCapUsd: 16_044_060,
    realMcapUsd: 15_846_825,
    graduatedAt: "2026-07-19T08:24:29.352Z",
  },
  {
    token: "0xe8ffd7e24187F72afB08d75B1bb13088A989a791",
    deployer: "0x1EAFc3E30f9F6DDFC53DC3EaB028A31BA4B8B0f8",
    name: "Delta",
    symbol: "DELTA",
    logo: "ipfs://bafkreihm7smghs6ew7rkpv6i7cbd3rglptqfcmddxagz7fycqklqkzzzta",
    marketCapUsd: 13_742_516,
    realMcapUsd: 13_742_516,
    graduatedAt: "2026-08-01T15:31:46.704Z",
  },
  {
    token: "0xB0Fea401F1ee62F0e7cC3Bdf94b20c25aB5117e2",
    deployer: "0x0E36c8df908C8dd2913853D3C7235a567E0288Df",
    name: "Motion",
    symbol: "MOTION",
    logo: "ipfs://bafybeibfsmpoq377wqebjlvbhfqvh4f7pjlplvjk7lhfakj4fhc3eosbhu",
    marketCapUsd: 7_711_777,
    realMcapUsd: 7_011_636,
    graduatedAt: "2026-07-19T18:16:28.303Z",
  },
  {
    token: "0xD5f1afEA47b1A9eab414D2ee740cF1d6d039E725",
    deployer: "0x0DABEE4B5983fb4B7d19cAea80eC54E7246Ce52d",
    name: "microduck",
    symbol: "microduck",
    logo: "https://axiomtrading-v2.axiom-cdn.io/6MTJE7ySqC1ENB7ZYDvVarEG71S7N3SuyyPrL83nbdU9.webp",
    marketCapUsd: 6_524_468,
    graduatedAt: "2026-08-27T11:48:43.000Z",
    version: "v2",
  },
  {
    token: "0x62C71cd34a52c30d894419CBcc55Db2aFA8032eA",
    deployer: "0xE0b5Ee397C1684565e581c1566370C39d6393e55",
    name: "YOLO",
    symbol: "YOLO",
    logo: "ipfs://bafkreifwfijzaczalvtdl5dtkeu7yy3ifesx6gmbrs5pi2jzjv2cqk4ewi",
    marketCapUsd: 6_231_787,
    realMcapUsd: 6_044_833,
    graduatedAt: "2026-07-17T21:24:02.044Z",
  },
  {
    token: "0xeE5576Fa1Bcaa380e591D01245f406f3f384eb01",
    deployer: "0xeD1FA21329fc45860cAB5D5E26a5fafcCDAcd6D5",
    name: "Down to Finance",
    symbol: "DTF",
    logo: "ipfs://bafybeictkpzyg4j4xknekcllmmsmli5imtej4vkjo32ckrzedopattilke",
    marketCapUsd: 5_291_121,
    graduatedAt: "2026-08-25T01:35:27.000Z",
    version: "v2",
  },
  {
    token: "0x451b42A15100C340CA12F7c66DE06fac5EA2D751",
    deployer: "0x69C3eaDC15Cb2b505193D94e041299cA885A7DA9",
    name: "Longbow",
    symbol: "BOW",
    logo: "ipfs://bafkreie3adpvb2ogx5btharginrahlzczwj2fyuiydkvrelw42jneti27e",
    marketCapUsd: 4_244_353,
    graduatedAt: "2026-08-08T21:00:45.000Z",
    version: "v2",
  },
  {
    token: "0x9cA1cC0c90d97B4F36c5E2232d4fbD705a73c65d",
    deployer: "0xA94b7E35CBbF9340AD92331A00898c7e5824e2D4",
    name: "TA FUND",
    symbol: "TA",
    logo: "ipfs://bafybeibgktqb6457mgga5pixhahu4bt7zgm2f73vebwfyniqmyktoel2cu",
    marketCapUsd: 2_810_882,
    graduatedAt: "2026-08-05T21:14:58.000Z",
    version: "v2",
  },
  {
    token: "0xa0e67be79118704A35e7d4b20C3EC4Df36EF6e10",
    deployer: "0xDA3a2167648328F2B244767dc733cf07c59dD708",
    name: "Pons Index",
    symbol: "PONSFOLIO",
    logo: "ipfs://bafybeigyzr43tpnaht3b2ytkrlykzgnghaualmhiyordlou6crylyqtije",
    marketCapUsd: 2_286_092,
    graduatedAt: "2026-08-27T22:00:39.000Z",
    version: "v2",
  },
];

const DEMO_PONS_MARKETS: readonly PonsMarket[] = [
  {
    name: "Night Market",
    symbol: "NITE",
    token: demoToken,
    description: "The market stays open after midnight.",
    marketCap: "$7.01M",
    volume: "$601.2K",
    age: "12m",
    version: "V2",
    glyph: "N",
    art: "night",
    progress: 74,
  },
  {
    name: "Thinking Cat",
    symbol: "HMM",
    token: demoToken,
    description: "Nine lives, one very considered position.",
    marketCap: "$15.11M",
    volume: "$984K",
    age: "18m",
    version: "V2",
    glyph: "?",
    art: "cat",
    progress: 92,
  },
  {
    name: "Delta",
    symbol: "DELTA",
    token: demoToken,
    description: "Small moves, visible momentum.",
    marketCap: "$12.79M",
    volume: "$720K",
    age: "27m",
    version: "V1",
    glyph: "Δ",
    art: "delta",
    progress: 86,
  },
  {
    name: "Motion",
    symbol: "MOTION",
    token: demoToken,
    description: "A token for things already in motion.",
    marketCap: "$7.04M",
    volume: "$488K",
    age: "39m",
    version: "V1",
    glyph: "↗",
    art: "motion",
    progress: 68,
  },
  {
    name: "Longwave",
    symbol: "BOW",
    token: demoToken,
    description: "Signals carried across the long horizon.",
    marketCap: "$3.76M",
    volume: "$213K",
    age: "1h",
    version: "V2",
    glyph: "L",
    art: "longwave",
    progress: 49,
  },
  {
    name: "Pixel Garden",
    symbol: "PXG",
    token: demoToken,
    description: "A small plot of internet culture.",
    marketCap: "$2.91M",
    volume: "$186K",
    age: "2h",
    version: "V2",
    glyph: "✣",
    art: "garden",
    progress: 41,
  },
  {
    name: "Afterglow",
    symbol: "GLOW",
    token: demoToken,
    description: "The part of the launch that lingers.",
    marketCap: "$1.82M",
    volume: "$129K",
    age: "3h",
    version: "V2",
    glyph: "○",
    art: "glow",
    progress: 32,
  },
  {
    name: "Robinhood Dog",
    symbol: "BRODIE",
    token: demoToken,
    description: "A loyal companion for Robinhood Chain.",
    marketCap: "$2.76M",
    volume: "$204K",
    age: "4h",
    version: "V1",
    glyph: "R",
    art: "dog",
    progress: 38,
  },
];

const routeLabels: Record<
  Exclude<OperationStage, "idle" | "complete">,
  string
> = {
  identity: "Creating an onchain-separated account",
  funding: "Moving funds from Private Balance",
  executing: "Submitting public EVM calls",
  returning: "Returning USDC to Private Balance",
};

type ProcessLogStatus = "pending" | "running" | "done" | "error";

interface ProcessLogEntry {
  id: string;
  title: string;
  status: ProcessLogStatus;
  detail: string;
  updatedAt: number;
  transactionHash?: string;
  explorerUrl?: string;
}

interface DepositLogEntry extends ProcessLogEntry {
  id: "identity" | "source" | "relay" | "register" | "deposit" | "reconcile";
}

type ExecutionLogId =
  | "identity"
  | "bridge"
  | "funding-relay"
  | "execution"
  | "confirmation"
  | "reconcile";

interface ExecutionLogEntry extends ProcessLogEntry {
  id: ExecutionLogId;
  operation: string;
}

const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const ROBINHOOD_EXPLORER_URL = "https://robinhoodchain.blockscout.com";
const DEPOSIT_LOG_STORAGE_KEY = "privatepons-deposit-process-v1";
const DEPOSIT_HASH_STORAGE_KEY = "privatepons-deposit-hash-v1";
const EXECUTION_LOG_STORAGE_KEY = "privatepons-execution-process-v1";
// The official bridge intentionally leaves/ignores tiny fee rounding residue.
// Treat the same <= 0.05 USDC threshold as dust so the UI cannot offer a
// second resume after the private note was already created.
const PENDING_DEPOSIT_DUST_THRESHOLD = 50_000n;

function actionablePendingDeposit(amount: bigint): bigint {
  return amount > PENDING_DEPOSIT_DUST_THRESHOLD ? amount : 0n;
}

function createDepositLog(amount: number): DepositLogEntry[] {
  const now = Date.now();
  return [
    {
      id: "identity",
      title: "Private identity",
      status: "running",
      detail:
        "Preparing the STRK20 identity without logging its secret material.",
      updatedAt: now,
    },
    {
      id: "source",
      title: "Robinhood transfer",
      status: "pending",
      detail: `${amount.toLocaleString()} USDG will move from the connected wallet.`,
      updatedAt: now,
    },
    {
      id: "relay",
      title: "Relay settlement",
      status: "pending",
      detail: "Waiting for Robinhood → Arbitrum delivery.",
      updatedAt: now,
    },
    {
      id: "register",
      title: "Circle registration",
      status: "pending",
      detail: "Waiting for the cross-chain message.",
      updatedAt: now,
    },
    {
      id: "deposit",
      title: "STRK20 pool deposit",
      status: "pending",
      detail: "The final step creates the private balance note.",
      updatedAt: now,
    },
  ];
}

function createTrackedDepositLog(transactionHash: string): DepositLogEntry[] {
  const log = createDepositLog(0);
  return log.map((entry) => {
    if (entry.id === "identity") {
      return {
        ...entry,
        status: "done",
        detail: "Tracking an existing public deposit transaction.",
      };
    }
    if (entry.id === "source") {
      return {
        ...entry,
        status: "running",
        detail: "Checking the Robinhood transaction receipt.",
        transactionHash,
        explorerUrl: `${ROBINHOOD_EXPLORER_URL}/tx/${transactionHash}`,
      };
    }
    return entry;
  });
}

function createExecutionLog(
  operation: string,
  amount: bigint,
  symbol: string,
  alreadyFunded = false,
): ExecutionLogEntry[] {
  const now = Date.now();
  const amountLabel = formatUsdc(amount);
  return [
    {
      id: "identity",
      operation,
      title: "Fresh account identity",
      status: "running",
      detail:
        "Restoring the onchain-separated account without logging secret material.",
      updatedAt: now,
    },
    {
      id: "bridge",
      operation,
      title: "STRK20 private withdrawal",
      status: alreadyFunded ? "done" : "pending",
      detail: alreadyFunded
        ? `${amountLabel} USDC is already held by this fresh account.`
        : `Preparing ${amountLabel} private USDC for the fresh account.`,
      updatedAt: now,
    },
    {
      id: "funding-relay",
      operation,
      title: "Cross-chain funding",
      status: alreadyFunded ? "done" : "pending",
      detail: alreadyFunded
        ? "Existing Robinhood funds will be reused; no second bridge transfer."
        : "Waiting for Circle and Relay to deliver Robinhood USDG.",
      updatedAt: now,
    },
    {
      id: "execution",
      operation,
      title: "Pons quote and execution",
      status: "pending",
      detail: `A Pons ${operation.toLowerCase()} for $${symbol} will be quoted, authorized, and policy-checked.`,
      updatedAt: now,
    },
    {
      id: "confirmation",
      operation,
      title: "Robinhood confirmation",
      status: "pending",
      detail: "No public transaction has been broadcast yet.",
      updatedAt: now,
    },
    {
      id: "reconcile",
      operation,
      title: "Position reconciliation",
      status: "pending",
      detail:
        "The app will verify the fresh account balance after confirmation.",
      updatedAt: now,
    },
  ];
}

function loadDepositLog(): DepositLogEntry[] {
  try {
    const value = localStorage.getItem(DEPOSIT_LOG_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as DepositLogEntry[]) : [];
  } catch {
    return [];
  }
}

function loadExecutionLog(): ExecutionLogEntry[] {
  try {
    const value = localStorage.getItem(EXECUTION_LOG_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as ExecutionLogEntry[]) : [];
  } catch {
    return [];
  }
}

function initialTrackedDepositHash(): string {
  const queryHash = new URLSearchParams(window.location.search).get("track");
  if (queryHash && TRANSACTION_HASH_PATTERN.test(queryHash)) return queryHash;
  const savedHash = localStorage.getItem(DEPOSIT_HASH_STORAGE_KEY) ?? "";
  return TRANSACTION_HASH_PATTERN.test(savedHash) ? savedHash : "";
}

function shorten(value: string, head = 6, tail = 4): string {
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatUsdc(value: bigint): string {
  return (Number(value) / Number(USDC_SCALE)).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function formatUsdcPrecise(value: bigint): string {
  return (Number(value) / Number(USDC_SCALE)).toLocaleString(undefined, {
    minimumFractionDigits: value > 0n && value < USDC_SCALE ? 4 : 0,
    maximumFractionDigits: 4,
  });
}

function formatSignedUsdc(value: bigint): string {
  const sign = value > 0n ? "+" : value < 0n ? "−" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${formatUsdcPrecise(absolute)}`;
}

function formatPortfolioTime(value?: number): string {
  if (!value) return "Not checked";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function formatTokenAmount(value: bigint): string {
  return (Number(value) / 1e18).toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
}

function positionStatusLabel(position: PrivatePosition): string {
  const labels: Record<PrivatePosition["status"], string> = {
    funding: "Funding",
    launching: "Deploying",
    buying: "Buying",
    held: "Held",
    selling: "Selling",
    returning: "Returning",
    "return-failed": "Return needed",
    "buy-failed": "Buy needs retry",
    failed: "Recovery needed",
    closed: "Closed",
  };
  return labels[position.status];
}

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Something went wrong";
  const requestSuffix =
    error instanceof RelayerRejectedError && error.requestId
      ? ` Reference: ${error.requestId}.`
      : "";
  if (walletErrorCode(error) === -32002 || /already pending/i.test(message)) {
    return "Open MetaMask and finish the pending request, then try again.";
  }
  if (
    /relayer rejected/i.test(message) &&
    /(exceeds the balance|insufficient funds|insufficient balance|gas account .* has no (?:Robinhood )?ETH)/i.test(
      message,
    )
  ) {
    return `The PonsButPrivate relayer is out of Robinhood ETH. This private execution was rejected before broadcast — no transaction was created and the USDG remains in the fresh account.${requestSuffix}`;
  }
  if (
    /relayer rejected execution with status 401/i.test(message) ||
    /relayer.*unauthorized/i.test(message)
  ) {
    return "The policy relayer rejected authentication before broadcast. No buy transaction was created and the USDC remains in the fresh account.";
  }
  if (/relayer rejected execution with status 400/i.test(message)) {
    const detail = boundedRelayerDetail(message);
    return `The policy relayer rejected this private execution before broadcast${
      detail ? `: ${detail}` : "."
    } No Robinhood transaction was created and the USDG remains in the fresh account.${requestSuffix}`;
  }
  if (/relay quote/i.test(message) && /amount too low/i.test(message)) {
    return "Relay cannot return this amount yet because it is too low to cover the swap fees and Arbitrum gas top-up. The USDG remains in the recorded fresh Robinhood account; retry when Relay fees are lower.";
  }
  if (/eth_getLogs|log query timed out/i.test(message)) {
    return "Robinhood RPC timed out while scanning position history. Existing saved positions remain available; try recovery again shortly.";
  }
  if (isAmbiguousPaymasterSubmissionMessage(message)) {
    return "The paymaster reports that this transaction was already submitted or its nonce was used. It may already have completed, so PonsButPrivate is reconciling onchain state without repeating the public transfer.";
  }
  return message;
}

function boundedRelayerDetail(message: string): string | undefined {
  const match = message.match(
    /relayer rejected execution with status \d+\s*:\s*(.+)$/i,
  );
  const detail = match?.[1]?.replace(/\s+/g, " ").trim();
  if (!detail) return undefined;
  return detail.length > 240 ? `${detail.slice(0, 237)}…` : detail;
}

function isAmbiguousPaymasterSubmissionMessage(message: string): boolean {
  return (
    /tx already sent|transaction already (?:sent|submitted|known)|already known/i.test(
      message,
    ) ||
    (/nonce already used/i.test(message) &&
      /paymaster|argent\/multicall-failed|code 156/i.test(message))
  );
}

function isAmbiguousPaymasterSubmissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isAmbiguousPaymasterSubmissionMessage(message);
}

function walletErrorCode(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  const value = error as {
    code?: unknown;
    cause?: unknown;
    data?: { originalError?: unknown };
  };
  return (
    value.code ??
    walletErrorCode(value.cause) ??
    walletErrorCode(value.data?.originalError)
  );
}

function usdcBaseUnits(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  const [whole = "0", fraction = ""] = value.toFixed(6).split(".");
  return BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(6, "0"));
}

function formatWait(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.ceil(minutes / 60)}h`;
}

function privateBalanceRestMs(): number {
  const randomness = new Uint32Array(1);
  crypto.getRandomValues(randomness);
  const minutes =
    MINIMUM_PRIVATE_REST_MINUTES +
    (randomness[0]! % RANDOM_PRIVATE_REST_MINUTES);
  return minutes * 60 * 1_000;
}

function ponsAssetUrls(value: string): string[] {
  const source = value.trim();
  if (!source) return [];
  const ipfsGatewayUrls = (path: string): string[] => {
    const encodedPath = encodeURI(path);
    return [
      `https://gateway.pinata.cloud/ipfs/${encodedPath}`,
      `https://ipfs.filebase.io/ipfs/${encodedPath}`,
      `https://4everland.io/ipfs/${encodedPath}`,
    ];
  };
  if (source.startsWith("ipfs://")) {
    const path = source.slice("ipfs://".length).replace(/^ipfs\//, "");
    return path ? ipfsGatewayUrls(path) : [];
  }
  try {
    const url = new URL(source, OFFICIAL_PONS_ORIGIN);
    const ipfsMarker = "/ipfs/";
    const ipfsMarkerIndex = url.pathname.indexOf(ipfsMarker);
    if (ipfsMarkerIndex >= 0) {
      const path = url.pathname.slice(ipfsMarkerIndex + ipfsMarker.length);
      return path ? ipfsGatewayUrls(path) : [];
    }
    return url.protocol === "https:" ? [url.href] : [];
  } catch {
    return [];
  }
}

function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "–";
  const units = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "k"],
  ] as const;
  for (const [threshold, suffix] of units) {
    if (value >= threshold) {
      return `$${(value / threshold).toFixed(value >= threshold * 10 ? 1 : 2).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return `$${value.toFixed(value >= 10 ? 0 : 2)}`;
}

function formatMarketAge(value?: string | null): string {
  if (!value) return "recent";
  const milliseconds = Date.now() - Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "recent";
  const hours = Math.floor(milliseconds / 3_600_000);
  if (hours < 1)
    return `${Math.max(1, Math.floor(milliseconds / 60_000))}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function App({ runtime }: AppProps) {
  const [workspace, setWorkspace] = useState<Workspace>("explore");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [marketSearch, setMarketSearch] = useState("");
  const [marketSort, setMarketSort] = useState<
    "recent" | "newest" | "oldest" | "market-cap" | "volume"
  >("recent");
  const [marketAge, setMarketAge] = useState<"all" | "24h" | "7d">("all");
  const [marketVersion, setMarketVersion] = useState<"both" | "v1" | "v2">(
    "both",
  );
  const [graduatedMarkets, setGraduatedMarkets] = useState<
    readonly GraduatedMarket[]
  >(FALLBACK_GRADUATED_MARKETS);
  const [graduatedCount, setGraduatedCount] = useState(331);
  const [launchCount, setLaunchCount] = useState(343_368);
  const [liveMarketMetadata, setLiveMarketMetadata] = useState<
    Record<
      string,
      {
        name: string;
        symbol: string;
        description?: string;
        imageSources?: readonly string[];
      }
    >
  >({});
  const markets = useMemo(() => {
    const baseMarkets =
      runtime.mode === "demo"
        ? [...DEMO_PONS_MARKETS, ...LIVE_PONS_MARKETS]
        : [...LIVE_PONS_MARKETS];
    return baseMarkets.map((market) => ({
      ...market,
      ...liveMarketMetadata[market.token.toLowerCase()],
    }));
  }, [liveMarketMetadata, runtime.mode]);
  const [selectedMarket, setSelectedMarket] = useState<PonsMarket>(() =>
    runtime.mode === "demo" ? DEMO_PONS_MARKETS[0]! : LIVE_PONS_MARKETS[0]!,
  );
  const [privateBalance, setPrivateBalance] = useState(() =>
    runtime.mode === "demo" ? 250_000_000n : 0n,
  );
  const [pendingDepositBalance, setPendingDepositBalance] = useState(0n);
  const [restingPrivateBalance, setRestingPrivateBalance] = useState(0n);
  const [privateBalanceReadyAt, setPrivateBalanceReadyAt] = useState<number>();
  const [clock, setClock] = useState(() => Date.now());
  const [balanceModal, setBalanceModal] = useState<"deposit" | "withdraw">();
  const [depositAmount, setDepositAmount] = useState(100);
  const [balanceStep, setBalanceStep] = useState<string>();
  const [depositLog, setDepositLog] =
    useState<DepositLogEntry[]>(loadDepositLog);
  const [executionLog, setExecutionLog] =
    useState<ExecutionLogEntry[]>(loadExecutionLog);
  const [transactionMonitorView, setTransactionMonitorView] = useState<
    "execution" | "deposit"
  >(() => (loadExecutionLog().length > 0 ? "execution" : "deposit"));
  const [trackedDepositHash, setTrackedDepositHash] = useState(
    initialTrackedDepositHash,
  );
  const [trackHashDraft, setTrackHashDraft] = useState(
    initialTrackedDepositHash,
  );
  const [transactionMonitorOpen, setTransactionMonitorOpen] = useState(
    () =>
      initialTrackedDepositHash().length > 0 || loadExecutionLog().length > 0,
  );
  const [receiptCheckError, setReceiptCheckError] = useState<string>();
  const [withdrawDestination, setWithdrawDestination] = useState(
    "0x7C26A0F7B7e9DfAA0D21e19b9E5D1D1D8bA84491",
  );
  const [stage, setStage] = useState<OperationStage>("idle");
  const [error, setError] = useState<string>();
  const [identity, setIdentity] = useState<PreparedIdentity>();
  const [funding, setFunding] = useState<BridgeFundResult>();
  const [returnResult, setReturnResult] = useState<BridgeReturnResult>();
  const [transactionHash, setTransactionHash] = useState<string>();
  const [connectedWallet, setConnectedWallet] =
    useState<PrivateLaunchpadSession["account"]>();
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [walletError, setWalletError] = useState<string>();

  const [name, setName] = useState("Night Market");
  const [symbol, setSymbol] = useState("NITE");
  const [description, setDescription] = useState(
    "The market stays open after midnight.",
  );
  const [xProfile, setXProfile] = useState("");
  const [telegram, setTelegram] = useState("");
  const [launchBudget, setLaunchBudget] = useState(25);
  const [launchSalt, setLaunchSalt] = useState(createLaunchSalt);
  const [creatorReward, setCreatorReward] = useState(80);
  const [privateLaunchEnabled, setPrivateLaunchEnabled] = useState(true);
  const [tokenImageName, setTokenImageName] = useState<string>();
  const [tokenImagePreview, setTokenImagePreview] = useState<string>();
  const [tokenImageError, setTokenImageError] = useState<string>();
  const tokenImageInput = useRef<HTMLInputElement>(null);
  const launchInFlight = useRef(false);

  const [token, setToken] = useState(selectedMarket.token);
  const [tradeAmount, setTradeAmount] = useState(25);
  const [tradeSide, setTradeSide] = useState<"buy" | "sell">("buy");
  const [positions, setPositions] = useState<PrivatePosition[]>([]);
  const [portfolioSnapshots, setPortfolioSnapshots] = useState<
    Record<string, PortfolioSnapshot>
  >({});
  const [portfolioRefreshing, setPortfolioRefreshing] = useState(false);
  const portfolioRefreshId = useRef(0);
  const [positionRecovery, setPositionRecovery] =
    useState<PositionRecoveryState>({ status: "idle" });
  const positionRecoveryId = useRef(0);
  const storageScopesByRoot = useRef(new Map<string, PrivateStorageScope>());
  const [activePositionId, setActivePositionId] = useState<string>();
  const [lastTrade, setLastTrade] = useState<TradeExecution>();

  useEffect(() => {
    if (!runtime.readMarketMetadata) return undefined;
    let cancelled = false;
    void Promise.all(
      LIVE_PONS_MARKETS.map(async (market) => {
        try {
          const metadata = await runtime.readMarketMetadata!(market.token);
          const imageSources = metadata.logo
            ? ponsAssetUrls(metadata.logo)
            : [];
          return [
            market.token.toLowerCase(),
            {
              // Pons lists this legacy market as "Harvest" even though its
              // token contract retains the longer "Onchain Harvest" name.
              name:
                market.symbol === "HARVEST"
                  ? market.name
                  : metadata.name || market.name,
              symbol: metadata.symbol.replace(/^\$/, "") || market.symbol,
              ...(metadata.description
                ? { description: metadata.description }
                : {}),
              ...(imageSources.length > 0 ? { imageSources } : {}),
            },
          ] as const;
        } catch {
          return undefined;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setLiveMarketMetadata(
        Object.fromEntries(
          entries.filter(
            (entry): entry is NonNullable<(typeof entries)[number]> => !!entry,
          ),
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [runtime]);

  useEffect(() => {
    if (runtime.mode !== "live" || runtime.network.chainId !== 4663) {
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    const snapshotQuery = new URLSearchParams({
      explore: "1",
      sort: "recentBuys",
      age: "all",
      page: "1",
      pageSize: "1",
      graduatedPage: "1",
      graduatedPageSize: "1",
      includeGraduated: "0",
      v: "10",
    });
    void Promise.all([
      fetch(
        `${OFFICIAL_PONS_ORIGIN}/api/pons-launches/graduations?catalog=1&v=8`,
        { cache: "no-store", signal: controller.signal },
      ).then((response) => {
        if (!response.ok) throw new Error("Pons graduated catalog unavailable");
        return response.json() as Promise<unknown>;
      }),
      fetch(`${OFFICIAL_PONS_ORIGIN}/api/pons-launches?${snapshotQuery}`, {
        cache: "no-store",
        signal: controller.signal,
      }).then((response) => {
        if (!response.ok) throw new Error("Pons launch totals unavailable");
        return response.json() as Promise<unknown>;
      }),
    ])
      .then(([catalogPayload, snapshotPayload]) => {
        if (cancelled) return;
        if (Array.isArray(catalogPayload)) {
          const catalog = catalogPayload
            .filter(
              (entry): entry is GraduatedMarket =>
                !!entry &&
                typeof entry === "object" &&
                typeof (entry as GraduatedMarket).token === "string" &&
                typeof (entry as GraduatedMarket).deployer === "string" &&
                typeof (entry as GraduatedMarket).name === "string" &&
                typeof (entry as GraduatedMarket).symbol === "string" &&
                typeof (entry as GraduatedMarket).logo === "string" &&
                typeof (entry as GraduatedMarket).marketCapUsd === "number",
            )
            .sort(
              (left, right) =>
                (right.realMcapUsd ?? right.marketCapUsd) -
                (left.realMcapUsd ?? left.marketCapUsd),
            );
          if (catalog.length > 0) {
            setGraduatedCount(catalog.length);
            setGraduatedMarkets(catalog.slice(0, 10));
          }
        }
        if (snapshotPayload && typeof snapshotPayload === "object") {
          const total = (snapshotPayload as { launchTotal?: unknown })
            .launchTotal;
          if (typeof total === "number" && Number.isFinite(total)) {
            setLaunchCount(total);
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runtime.mode, runtime.network.chainId]);

  useEffect(() => {
    setSelectedMarket(
      (current) =>
        markets.find(
          (market) =>
            market.token.toLowerCase() === current.token.toLowerCase(),
        ) ?? current,
    );
  }, [markets]);

  const activePosition = positions.find(
    (position) => position.id === activePositionId,
  );
  const holding = Boolean(
    activePosition &&
    (activePosition.status === "held" ||
      (portfolioSnapshots[activePosition.id]?.tokenBalance ?? 0n) > 0n),
  );

  const launchDraft = useMemo<LaunchDraft>(
    () => ({
      name: name.trim(),
      symbol: symbol.trim().toUpperCase(),
      description: description.trim(),
      bridgeAmount: usdcBaseUnits(launchBudget),
      creatorReward,
      salt: launchSalt,
    }),
    [creatorReward, description, launchBudget, launchSalt, name, symbol],
  );
  const tradeDraft = useMemo<TradeDraft>(
    () => ({
      token,
      amountIn:
        tradeSide === "buy"
          ? usdcBaseUnits(tradeAmount)
          : activePosition
            ? (portfolioSnapshots[activePosition.id]?.tokenBalance ??
              (activePosition.tokenAmount
                ? BigInt(activePosition.tokenAmount)
                : 0n))
            : 0n,
      slippageBps: 100,
    }),
    [activePosition, portfolioSnapshots, token, tradeAmount, tradeSide],
  );
  const busy = !["idle", "complete"].includes(stage);
  const privateBalanceAvailable =
    privateBalance > restingPrivateBalance
      ? privateBalance - restingPrivateBalance
      : 0n;
  const privacyWaitRemaining = privateBalanceReadyAt
    ? Math.max(0, privateBalanceReadyAt - clock)
    : 0;
  const launchValid =
    privateLaunchEnabled &&
    launchDraft.name.length >= 2 &&
    /^[A-Z0-9]{2,10}$/.test(launchDraft.symbol) &&
    launchBudget >= 1 &&
    launchDraft.bridgeAmount <= privateBalanceAvailable;
  const privateFundingReady =
    launchDraft.bridgeAmount > 0n &&
    launchDraft.bridgeAmount <= privateBalanceAvailable;
  const privateFundingResting =
    launchDraft.bridgeAmount > privateBalanceAvailable &&
    launchDraft.bridgeAmount <= privateBalance &&
    privacyWaitRemaining > 0;
  const launchFundsCommitted = Boolean(funding || transactionHash);
  const privateRouteReady =
    privateLaunchEnabled && (privateFundingReady || launchFundsCommitted);
  const tradeValid =
    /^0x[0-9a-fA-F]{40}$/.test(token) &&
    tradeDraft.amountIn > 0n &&
    selectedMarket.privateTrading !== false &&
    (tradeSide === "sell"
      ? holding
      : tradeDraft.amountIn <= privateBalanceAvailable);
  const processEntries: ProcessLogEntry[] = [...executionLog, ...depositLog];
  const processStatus = processEntries.some((entry) => entry.status === "error")
    ? "error"
    : processEntries.some((entry) => entry.status === "running")
      ? "running"
      : processEntries.length > 0
        ? "done"
        : "idle";
  const activeProcessLog: ProcessLogEntry[] =
    transactionMonitorView === "execution" ? executionLog : depositLog;
  const visibleMarkets = useMemo(() => {
    const query = marketSearch.trim().toLowerCase();
    const versionFiltered =
      marketVersion === "both"
        ? markets
        : markets.filter(
            (market) => market.version.toLowerCase() === marketVersion,
          );
    const filtered = query
      ? versionFiltered.filter((market) =>
          [market.name, market.symbol, market.token].some((value) =>
            value.toLowerCase().includes(query),
          ),
        )
      : versionFiltered;

    if (marketSort === "newest") return [...filtered].reverse();
    if (marketSort === "oldest") return filtered;
    if (marketSort === "market-cap" || marketSort === "volume") {
      return [...filtered].sort(
        (left, right) => right.progress - left.progress,
      );
    }
    return filtered;
  }, [marketSearch, marketSort, marketVersion, markets]);

  const portfolioSummary = useMemo(() => {
    let executionCost = 0n;
    let estimatedExit = 0n;
    let valuedPositions = 0;
    let verifiedPositions = 0;
    let activePositions = 0;

    for (const position of positions) {
      const snapshot = portfolioSnapshots[position.id];
      const hasLiveTokens = (snapshot?.tokenBalance ?? 0n) > 0n;
      const isActive = hasLiveTokens || position.status !== "closed";
      if (isActive) {
        activePositions += 1;
        executionCost += BigInt(position.usdcCommitted);
      }
      if (snapshot?.status === "verified" || snapshot?.status === "empty") {
        verifiedPositions += 1;
      }
      if (snapshot?.estimatedUsdg !== undefined) {
        estimatedExit += snapshot.estimatedUsdg;
        valuedPositions += 1;
      }
    }

    return {
      activePositions,
      executionCost,
      estimatedExit,
      valuedPositions,
      verifiedPositions,
    };
  }, [portfolioSnapshots, positions]);

  const refreshPortfolio = useCallback(async () => {
    const refreshId = portfolioRefreshId.current + 1;
    portfolioRefreshId.current = refreshId;
    const tokenPositions = positions.filter(
      (
        position,
      ): position is PrivatePosition & {
        token: NonNullable<PrivatePosition["token"]>;
      } => Boolean(position.token),
    );

    if (tokenPositions.length === 0) {
      setPortfolioSnapshots({});
      setPortfolioRefreshing(false);
      return;
    }

    setPortfolioRefreshing(true);
    setPortfolioSnapshots((current) => {
      const next = { ...current };
      for (const position of tokenPositions) {
        next[position.id] = {
          ...current[position.id],
          status: "loading",
        };
      }
      return next;
    });

    const results = await Promise.all(
      tokenPositions.map(async (position) => {
        try {
          const tokenBalance = await runtime.readAccountTokenBalance(
            position.account,
            position.token,
          );
          const checkedAt = Date.now();
          if (tokenBalance === 0n) {
            return [
              position.id,
              { status: "empty", tokenBalance, checkedAt },
            ] as const;
          }

          try {
            const quote = await runtime.quoteSell(position.account, {
              token: position.token,
              amountIn: tokenBalance,
              slippageBps: 100,
            });
            return [
              position.id,
              {
                status: "verified",
                tokenBalance,
                estimatedUsdg: quote.amountOut,
                minimumUsdg: quote.minimumAmountOut,
                checkedAt,
              },
            ] as const;
          } catch (reason) {
            return [
              position.id,
              {
                status: "verified",
                tokenBalance,
                checkedAt,
                error: `Sell quote unavailable: ${errorMessage(reason)}`,
              },
            ] as const;
          }
        } catch (reason) {
          return [
            position.id,
            {
              status: "unavailable",
              checkedAt: Date.now(),
              error: errorMessage(reason),
            },
          ] as const;
        }
      }),
    );

    if (portfolioRefreshId.current !== refreshId) return;
    setPortfolioSnapshots((current) => ({
      ...current,
      ...Object.fromEntries(results),
    }));
    setPortfolioRefreshing(false);
  }, [positions, runtime]);

  useEffect(() => {
    if (workspace !== "positions" || !connectedWallet) return;
    void refreshPortfolio();
  }, [connectedWallet, refreshPortfolio, workspace]);

  const updateDepositLog = useCallback(
    (
      id: DepositLogEntry["id"],
      patch: Partial<Omit<DepositLogEntry, "id">>,
    ) => {
      setDepositLog((current) => {
        const existing = current.find((entry) => entry.id === id);
        if (!existing) {
          const fallback = createTrackedDepositLog(
            trackedDepositHash || "0x".padEnd(66, "0"),
          ).find((entry) => entry.id === id);
          if (!fallback) return current;
          return [
            ...current,
            { ...fallback, ...patch, id, updatedAt: Date.now() },
          ];
        }
        return current.map((entry) =>
          entry.id === id
            ? { ...entry, ...patch, id, updatedAt: Date.now() }
            : entry,
        );
      });
    },
    [trackedDepositHash],
  );

  const updateExecutionLog = useCallback(
    (
      id: ExecutionLogId,
      patch: Partial<Omit<ExecutionLogEntry, "id" | "operation">>,
    ) => {
      setExecutionLog((current) =>
        current.map((entry) =>
          entry.id === id
            ? { ...entry, ...patch, id, updatedAt: Date.now() }
            : entry,
        ),
      );
    },
    [],
  );

  const beginExecutionLog = useCallback(
    (
      operation: string,
      amount: bigint,
      symbol: string,
      alreadyFunded = false,
    ) => {
      setExecutionLog(
        createExecutionLog(operation, amount, symbol, alreadyFunded),
      );
      setTransactionMonitorView("execution");
      setTransactionMonitorOpen(true);
    },
    [],
  );

  const failExecutionLog = useCallback((detail: string) => {
    setExecutionLog((current) => {
      const failed =
        current.find((entry) => entry.status === "running") ??
        current.find((entry) => entry.status === "pending");
      if (!failed) return current;
      return current.map((entry) =>
        entry.id === failed.id
          ? { ...entry, status: "error", detail, updatedAt: Date.now() }
          : entry,
      );
    });
  }, []);

  const trackDepositTransaction = useCallback((transactionHash: string) => {
    const normalized = transactionHash.trim();
    if (!TRANSACTION_HASH_PATTERN.test(normalized)) {
      setReceiptCheckError("Paste a complete 0x transaction hash.");
      return;
    }
    setReceiptCheckError(undefined);
    setTrackedDepositHash(normalized);
    setTrackHashDraft(normalized);
    setTransactionMonitorView("deposit");
    setTransactionMonitorOpen(true);
    setDepositLog((current) =>
      current.length > 0 ? current : createTrackedDepositLog(normalized),
    );
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DEPOSIT_LOG_STORAGE_KEY, JSON.stringify(depositLog));
    } catch {
      // The logger remains available in memory when storage is unavailable.
    }
  }, [depositLog]);

  useEffect(() => {
    try {
      localStorage.setItem(
        EXECUTION_LOG_STORAGE_KEY,
        JSON.stringify(executionLog),
      );
    } catch {
      // The logger remains available in memory when storage is unavailable.
    }
  }, [executionLog]);

  useEffect(() => {
    if (!trackedDepositHash) return;
    localStorage.setItem(DEPOSIT_HASH_STORAGE_KEY, trackedDepositHash);
    if (depositLog.length === 0) {
      setDepositLog(createTrackedDepositLog(trackedDepositHash));
    }
  }, [depositLog.length, trackedDepositHash]);

  useEffect(() => {
    if (!TRANSACTION_HASH_PATTERN.test(trackedDepositHash)) return undefined;
    let cancelled = false;
    let pollTimer: number | undefined;

    const checkReceipt = async () => {
      try {
        const response = await fetch(ROBINHOOD_RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getTransactionReceipt",
            params: [trackedDepositHash],
          }),
        });
        const payload = (await response.json()) as {
          result?: { status?: string; blockNumber?: string } | null;
          error?: { message?: string };
        };
        if (cancelled) return;
        if (!response.ok || payload.error) {
          throw new Error(payload.error?.message ?? "receipt lookup failed");
        }
        if (!payload.result) {
          updateDepositLog("source", {
            status: "running",
            detail: "Submitted · waiting for a Robinhood block confirmation.",
            transactionHash: trackedDepositHash,
            explorerUrl: `${ROBINHOOD_EXPLORER_URL}/tx/${trackedDepositHash}`,
          });
          pollTimer = window.setTimeout(checkReceipt, 5_000);
          return;
        }
        const blockNumber = payload.result.blockNumber
          ? Number.parseInt(payload.result.blockNumber, 16).toLocaleString()
          : "confirmed block";
        const succeeded = payload.result.status === "0x1";
        updateDepositLog("source", {
          status: succeeded ? "done" : "error",
          detail: succeeded
            ? `Confirmed successfully in Robinhood block ${blockNumber}.`
            : `Reverted in Robinhood block ${blockNumber}.`,
          transactionHash: trackedDepositHash,
          explorerUrl: `${ROBINHOOD_EXPLORER_URL}/tx/${trackedDepositHash}`,
        });
        setReceiptCheckError(undefined);
      } catch (reason) {
        if (cancelled) return;
        setReceiptCheckError(
          `Receipt check unavailable: ${errorMessage(reason)}`,
        );
        pollTimer = window.setTimeout(checkReceipt, 8_000);
      }
    };

    void checkReceipt();
    return () => {
      cancelled = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [trackedDepositHash, updateDepositLog]);

  function restorePositions(
    rootAddress: PrivateLaunchpadSession["account"],
  ): PrivatePosition[] {
    const restored = loadPrivatePositions(
      runtime.network.chainId,
      privateStorageScope(rootAddress),
    );
    setPositions(restored);
    return restored;
  }

  function rememberStorageScope(prepared: PreparedIdentity): void {
    storageScopesByRoot.current.set(
      prepared.connectedAddress.toLowerCase(),
      prepared.storageScope,
    );
    migratePrivateRecoveryStorage(
      runtime.network.chainId,
      prepared.connectedAddress,
      prepared.storageScope,
    );
  }

  function privateStorageScope(
    rootAddress: PrivateLaunchpadSession["account"],
  ): PrivateStorageScope {
    const scope = storageScopesByRoot.current.get(rootAddress.toLowerCase());
    if (!scope) {
      throw new Error("prepare the private identity before recovery access");
    }
    return scope;
  }

  async function recoverOnchainPositions(
    expectedRootAddress: PrivateLaunchpadSession["account"],
    basePositions?: readonly PrivatePosition[],
  ): Promise<PrivatePosition[]> {
    if (!runtime.recoverPositions) return [...(basePositions ?? positions)];

    const recoveryId = positionRecoveryId.current + 1;
    positionRecoveryId.current = recoveryId;
    setPositionRecovery({ status: "scanning" });

    try {
      // This reuses the signature already retained by the runtime. If an
      // operation reset it, the wallet is asked to authorize recovery again.
      const prepared = await runtime.prepareIdentity(0);
      const rootAddress = prepared.connectedAddress;
      rememberStorageScope(prepared);
      setConnectedWallet(rootAddress);
      setIdentity(prepared);
      const recovered = await runtime.recoverPositions();
      if (positionRecoveryId.current !== recoveryId) return [];

      const sameRoot =
        rootAddress.toLowerCase() === expectedRootAddress.toLowerCase();
      const current = sameRoot
        ? [
            ...(basePositions ??
              loadPrivatePositions(
                runtime.network.chainId,
                privateStorageScope(rootAddress),
              )),
          ]
        : loadPrivatePositions(
            runtime.network.chainId,
            privateStorageScope(rootAddress),
          );
      const next = mergeRecoveredPositions(current, recovered);
      savePrivatePositions(
        runtime.network.chainId,
        privateStorageScope(rootAddress),
        next,
      );
      setPositions(next);
      setPositionRecovery({
        status: "done",
        recovered: recovered.length,
        checkedAt: Date.now(),
      });
      return next;
    } catch (reason) {
      if (positionRecoveryId.current === recoveryId) {
        setPositionRecovery({
          status: "error",
          message: errorMessage(reason),
        });
      }
      return [...(basePositions ?? positions)];
    }
  }

  function commitPosition(
    rootAddress: PrivateLaunchpadSession["account"],
    position: PrivatePosition,
  ): PrivatePosition {
    const scope = privateStorageScope(rootAddress);
    const current = loadPrivatePositions(runtime.network.chainId, scope);
    const next = [
      position,
      ...current.filter((candidate) => candidate.id !== position.id),
    ].sort((left, right) => right.updatedAt - left.updatedAt);
    savePrivatePositions(runtime.network.chainId, scope, next);
    setPositions(next);
    return position;
  }

  function patchPosition(
    rootAddress: PrivateLaunchpadSession["account"],
    id: string,
    patch: Partial<PrivatePosition>,
  ): PrivatePosition | undefined {
    const current = loadPrivatePositions(
      runtime.network.chainId,
      privateStorageScope(rootAddress),
    );
    const position = current.find((candidate) => candidate.id === id);
    if (!position) return undefined;
    return commitPosition(rootAddress, {
      ...position,
      ...patch,
      id: position.id,
      updatedAt: Date.now(),
    });
  }

  function reconcileFundedIdentity(
    prepared: PreparedIdentity,
    result: BridgeFundResult,
  ): PreparedIdentity {
    if (result.accountIndex === prepared.session.accountIndex) return prepared;
    const reconciled: PreparedIdentity = {
      connectedAddress: prepared.connectedAddress,
      storageScope: prepared.storageScope,
      session: {
        accountIndex: result.accountIndex,
        channel: result.channel ?? prepared.session.channel,
        owner: result.eoaAddress as PrivateLaunchpadSession["owner"],
        account: result.depositWallet as PrivateLaunchpadSession["account"],
      },
    };
    setIdentity(reconciled);
    return reconciled;
  }

  useEffect(() => {
    if (!privateBalanceReadyAt) return undefined;
    const updateClock = () => setClock(Date.now());
    updateClock();
    const timer = window.setInterval(updateClock, 1_000);
    return () => window.clearInterval(timer);
  }, [privateBalanceReadyAt]);

  useEffect(() => {
    if (!privateBalanceReadyAt) return;
    const maximumReadyAt = Date.now() + 5 * 60 * 1_000;
    if (privateBalanceReadyAt > maximumReadyAt) {
      setPrivateBalanceReadyAt(Date.now() + privateBalanceRestMs());
    }
  }, [privateBalanceReadyAt]);

  useEffect(() => {
    if (!privateBalanceReadyAt || clock < privateBalanceReadyAt) return;
    setRestingPrivateBalance(0n);
    setPrivateBalanceReadyAt(undefined);
    if (connectedWallet) {
      clearPrivateBalanceRest(
        runtime.network.chainId,
        privateStorageScope(connectedWallet),
      );
    }
  }, [clock, connectedWallet, privateBalanceReadyAt, runtime.network.chainId]);

  useEffect(() => {
    localStorage.removeItem(`plank-launch-activity-${runtime.network.chainId}`);
  }, [runtime.network.chainId]);

  function switchWorkspace(next: Workspace) {
    if (busy || next === workspace) return;
    // The portfolio is read-only and needs the prepared identity for live
    // position quotes. Preserve it while entering the vault; reset whenever a
    // new execution workspace is selected.
    if (next !== "positions") runtime.reset();
    setWorkspace(next);
    setStage("idle");
    if (next !== "positions") setIdentity(undefined);
    setFunding(undefined);
    setReturnResult(undefined);
    setTransactionHash(undefined);
    setLastTrade(undefined);
    setError(undefined);
  }

  function openMarket(market: PonsMarket) {
    if (busy) return;
    runtime.reset();
    setSelectedMarket(market);
    setToken(market.token);
    setTradeSide("buy");
    setActivePositionId(undefined);
    setStage("idle");
    setIdentity(undefined);
    setFunding(undefined);
    setReturnResult(undefined);
    setTransactionHash(undefined);
    setLastTrade(undefined);
    setError(undefined);
    setWorkspace("trade");
    if (!navigator.userAgent.toLowerCase().includes("jsdom")) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function openGraduatedMarket(market: GraduatedMarket) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(market.token)) return;
    openMarket({
      name: market.name,
      symbol: market.symbol.replace(/^\$/, ""),
      token: market.token as PrivateLaunchpadSession["account"],
      description:
        market.version?.toLowerCase() === "v2"
          ? "A graduated Pons V2 market on Robinhood Chain. Private graduated-market trading is not supported yet."
          : "A graduated Pons market on Robinhood Chain. Legacy pools may use a different execution adapter.",
      marketCap: formatUsdCompact(market.realMcapUsd ?? market.marketCapUsd),
      volume: "Graduated pool",
      age: formatMarketAge(market.graduatedAt ?? market.launchedAt),
      version: market.version?.toLowerCase() === "v2" ? "V2" : "V1",
      glyph: market.name.slice(0, 1).toUpperCase(),
      art: "night",
      progress: 100,
      live: true,
      privateTrading: false,
      imageSources: ponsAssetUrls(market.logo),
    });
  }

  function openSearchedAddress() {
    const searchedToken = marketSearch.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(searchedToken)) return;
    const knownMarket = markets.find(
      (market) => market.token.toLowerCase() === searchedToken.toLowerCase(),
    );
    openMarket(
      knownMarket ?? {
        name: "Contract market",
        symbol: "TOKEN",
        token: searchedToken as PrivateLaunchpadSession["account"],
        description: "A Pons market opened directly from its token contract.",
        marketCap: "Onchain",
        volume: "Custom token",
        age: "now",
        version: "V2",
        glyph: "P",
        art: "night",
        progress: 50,
        live: runtime.mode !== "demo",
      },
    );
  }

  function selectTokenImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!["image/jpeg", "image/png"].includes(file.type)) {
      setTokenImageError("Choose a JPEG or PNG image.");
      event.target.value = "";
      return;
    }

    if (file.size > 1024 * 1024) {
      setTokenImageError("Image must be 1MB or smaller.");
      event.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      setTokenImageName(file.name);
      setTokenImagePreview(reader.result);
      setTokenImageError(undefined);
    };
    reader.onerror = () => setTokenImageError("Could not read that image.");
    reader.readAsDataURL(file);
  }

  async function connectEvmWallet() {
    if (walletConnecting) return undefined;
    setWalletConnecting(true);
    setWalletError(undefined);
    try {
      const prepared = await runtime.prepareIdentity(0);
      rememberStorageScope(prepared);
      setConnectedWallet(prepared.connectedAddress);
      const restored = restorePositions(prepared.connectedAddress);
      if (runtime.recoverPositions) {
        void recoverOnchainPositions(prepared.connectedAddress, restored);
      }
      const [recoveredBalance, pendingDeposit] = await Promise.all([
        runtime.readPrivateBalance(),
        runtime.readPendingDeposit(),
      ]);
      setPrivateBalance(recoveredBalance);
      setPendingDepositBalance(actionablePendingDeposit(pendingDeposit));
      const savedRest = loadPrivateBalanceRest(
        runtime.network.chainId,
        prepared.storageScope,
      );
      if (
        savedRest &&
        savedRest.readyAt > Date.now() &&
        BigInt(savedRest.amount) <= recoveredBalance
      ) {
        setRestingPrivateBalance(BigInt(savedRest.amount));
        setPrivateBalanceReadyAt(savedRest.readyAt);
      } else {
        clearPrivateBalanceRest(runtime.network.chainId, prepared.storageScope);
        setRestingPrivateBalance(0n);
        setPrivateBalanceReadyAt(undefined);
      }
      setIdentity(prepared);
      return prepared.connectedAddress;
    } catch (reason) {
      setWalletError(errorMessage(reason));
      return undefined;
    } finally {
      setWalletConnecting(false);
    }
  }

  async function openLaunchDeposit() {
    if (busy || !privateLaunchEnabled) return;
    if (runtime.mode === "live" && !connectedWallet) {
      const address = await connectEvmWallet();
      if (!address) return;
    }
    const suggestedAmount =
      actionablePendingDeposit(pendingDepositBalance) > 0n
        ? Number(pendingDepositBalance / USDC_SCALE)
        : launchBudget;
    setDepositAmount(suggestedAmount);
    setBalanceStep(undefined);
    setError(undefined);
    setBalanceModal("deposit");
  }

  async function prepareFreshIdentity(
    accountIndex?: number,
  ): Promise<PreparedIdentity> {
    if (
      identity &&
      (accountIndex === undefined ||
        identity.session.accountIndex === accountIndex)
    ) {
      return identity;
    }
    setStage("identity");
    const prepared = await runtime.prepareIdentity(accountIndex);
    rememberStorageScope(prepared);
    setConnectedWallet(prepared.connectedAddress);
    if (!connectedWallet) restorePositions(prepared.connectedAddress);
    setIdentity(prepared);
    return prepared;
  }

  function reconcileCompletedDeposit(
    previousBalance: bigint,
    recoveredBalance: bigint,
    rootAddress?: PrivateLaunchpadSession["account"],
  ) {
    const newlyPrivate =
      recoveredBalance > previousBalance
        ? recoveredBalance - previousBalance
        : 0n;
    setPrivateBalance(recoveredBalance);
    if (newlyPrivate <= 0n) return;

    const now = Date.now();
    const savedRest = rootAddress
      ? loadPrivateBalanceRest(
          runtime.network.chainId,
          privateStorageScope(rootAddress),
        )
      : undefined;
    const existingRest =
      savedRest && savedRest.readyAt > now ? BigInt(savedRest.amount) : 0n;
    const restingAmount = existingRest + newlyPrivate;
    const readyAt = now + privateBalanceRestMs();
    setRestingPrivateBalance(restingAmount);
    setClock(now);
    setPrivateBalanceReadyAt(readyAt);
    if (rootAddress) {
      savePrivateBalanceRest(
        runtime.network.chainId,
        privateStorageScope(rootAddress),
        {
          amount: restingAmount.toString(),
          readyAt,
        },
      );
    }
  }

  async function deposit() {
    if (depositAmount <= 0 || busy) return;
    if (actionablePendingDeposit(pendingDepositBalance) > 0n) {
      await finishPendingDeposit();
      return;
    }
    setError(undefined);
    setBalanceStep(undefined);
    setDepositLog(createDepositLog(depositAmount));
    setTransactionMonitorView("deposit");
    setTransactionMonitorOpen(true);
    const previousBalance = privateBalance;
    let prepared: PreparedIdentity | undefined;
    let sourceSubmitted = false;
    try {
      prepared = await prepareFreshIdentity();
      updateDepositLog("identity", {
        status: "done",
        detail:
          "Identity prepared. Secret material remains local and is not logged.",
      });
      await runtime.deposit(
        usdcBaseUnits(depositAmount),
        (step, status, detail, stepTransactionHash) => {
          const loggerStep =
            step === "deploy" ? (sourceSubmitted ? "relay" : "source") : step;
          if (status === "running") {
            setBalanceStep(detail ? `${step}: ${detail}` : step);
          }
          updateDepositLog(loggerStep, {
            status,
            detail:
              detail ??
              (status === "done"
                ? "Stage completed."
                : "Waiting for the next confirmation."),
            ...(stepTransactionHash
              ? { transactionHash: stepTransactionHash }
              : {}),
          });
        },
        ({ burnTxHash, explorerUrl }) => {
          sourceSubmitted = true;
          setTrackedDepositHash(burnTxHash);
          setTrackHashDraft(burnTxHash);
          updateDepositLog("source", {
            status: "running",
            detail:
              "Submitted to Robinhood Mainnet · waiting for confirmation.",
            transactionHash: burnTxHash,
            explorerUrl:
              explorerUrl ?? `${ROBINHOOD_EXPLORER_URL}/tx/${burnTxHash}`,
          });
          updateDepositLog("relay", {
            status: "running",
            detail: "Waiting for Relay to deliver USDC on Arbitrum.",
          });
        },
      );
      updateDepositLog("deposit", {
        status: "done",
        detail: "Private balance note created successfully.",
      });
      updateDepositLog("reconcile", {
        status: "running",
        detail: "Discovering the new private balance note.",
      });
      reconcileCompletedDeposit(
        previousBalance,
        await runtime.readPrivateBalance(),
        prepared.connectedAddress,
      );
      updateDepositLog("reconcile", {
        status: "done",
        detail: "Private balance reconciled. The deposit process is complete.",
      });
      setStage("idle");
      setBalanceModal(undefined);
      setBalanceStep(undefined);
      runtime.reset();
      setIdentity(undefined);
    } catch (reason) {
      updateDepositLog("reconcile", {
        status: "running",
        detail: isAmbiguousPaymasterSubmissionError(reason)
          ? "An ambiguous paymaster submission was detected. Checking whether the original transaction already completed."
          : "Checking balances before reporting a failure.",
      });
      if (isAmbiguousPaymasterSubmissionError(reason)) {
        try {
          const [remaining, recoveredBalance] = await Promise.all([
            runtime.readPendingDeposit(),
            runtime.readPrivateBalance(),
          ]);
          const actionableRemaining = actionablePendingDeposit(remaining);
          setPendingDepositBalance(actionableRemaining);
          if (recoveredBalance > previousBalance) {
            reconcileCompletedDeposit(
              previousBalance,
              recoveredBalance,
              prepared?.connectedAddress,
            );
            updateDepositLog("deposit", {
              status: "done",
              detail:
                "The original paymaster transaction completed successfully.",
            });
            updateDepositLog("reconcile", {
              status: "done",
              detail:
                "Recovered from the duplicate submission without sending another public transfer.",
            });
            setStage("idle");
            setBalanceModal(undefined);
            setBalanceStep(undefined);
            return;
          }
          if (actionableRemaining > 0n) {
            updateDepositLog("relay", {
              status: "done",
              detail: `${formatUsdc(actionableRemaining)} USDC reached the STRK20 staging balance.`,
            });
            updateDepositLog("deposit", {
              status: "pending",
              detail:
                "Ready to resume safely. No new Robinhood transfer will be sent.",
            });
            updateDepositLog("reconcile", {
              status: "done",
              detail:
                "Duplicate submission recovered; final pool step is ready.",
            });
            setStage("idle");
            setBalanceStep("deposit ready to resume");
            setError(undefined);
            return;
          }
        } catch {
          // Fall through to the recoverable status below.
        }
        updateDepositLog("reconcile", {
          status: "running",
          detail:
            "The original transaction is still settling. Keep this process log open; the public transfer will not be repeated.",
        });
      } else {
        updateDepositLog("reconcile", {
          status: "error",
          detail: errorMessage(reason),
        });
      }
      setStage("idle");
      setError(errorMessage(reason));
    }
  }

  async function finishPendingDeposit() {
    if (actionablePendingDeposit(pendingDepositBalance) <= 0n || busy) return;
    setError(undefined);
    setBalanceStep(undefined);
    if (depositLog.length === 0) {
      setDepositLog(createDepositLog(Number(pendingDepositBalance) / 1e6));
    }
    setTransactionMonitorView("deposit");
    setTransactionMonitorOpen(true);
    updateDepositLog("source", {
      status: "done",
      detail:
        "Public transfer already completed; resume will not send it again.",
    });
    updateDepositLog("relay", {
      status: "done",
      detail: `${formatUsdc(pendingDepositBalance)} USDC is available in staging.`,
    });
    const previousBalance = privateBalance;
    let prepared: PreparedIdentity | undefined;
    try {
      prepared = await prepareFreshIdentity();

      // Re-read immediately before execution. resume:true in the runtime makes
      // this path incapable of creating another public bridge transfer.
      const pendingAmount = await runtime.readPendingDeposit();
      const actionableAmount = actionablePendingDeposit(pendingAmount);
      setPendingDepositBalance(actionableAmount);
      if (actionableAmount <= 0n) {
        setPrivateBalance(await runtime.readPrivateBalance());
        setStage("idle");
        setBalanceModal(undefined);
        return;
      }

      await runtime.resumeDeposit(actionableAmount, (step, status, detail) => {
        if (status === "running") {
          setBalanceStep(detail ? `${step}: ${detail}` : step);
        }
        updateDepositLog(step === "deploy" ? "relay" : step, {
          status,
          detail:
            detail ??
            (status === "done"
              ? "Stage completed."
              : "Resuming from the durable bridge cursor."),
        });
      });
      const remaining = await runtime.readPendingDeposit();
      const actionableRemaining = actionablePendingDeposit(remaining);
      setPendingDepositBalance(actionableRemaining);
      if (actionableRemaining > 0n) {
        throw new Error(
          `${formatUsdc(actionableRemaining)} USDC is still awaiting the STRK20 step. Finish deposit again; no new Robinhood transfer will be created.`,
        );
      }

      reconcileCompletedDeposit(
        previousBalance,
        await runtime.readPrivateBalance(),
        prepared.connectedAddress,
      );
      updateDepositLog("deposit", {
        status: "done",
        detail: "Private balance note created successfully.",
      });
      updateDepositLog("reconcile", {
        status: "done",
        detail: "Recovered deposit completed without another public transfer.",
      });
      setStage("idle");
      setBalanceModal(undefined);
      setBalanceStep(undefined);
    } catch (reason) {
      // A paymaster retry can race a transaction that already succeeded. If
      // the transparent Starknet balance is now zero, recover from note
      // discovery and treat the operation as complete.
      try {
        const remaining = await runtime.readPendingDeposit();
        const actionableRemaining = actionablePendingDeposit(remaining);
        setPendingDepositBalance(actionableRemaining);
        if (actionableRemaining === 0n) {
          reconcileCompletedDeposit(
            previousBalance,
            await runtime.readPrivateBalance(),
            prepared?.connectedAddress,
          );
          setStage("idle");
          setBalanceModal(undefined);
          setBalanceStep(undefined);
          updateDepositLog("deposit", {
            status: "done",
            detail:
              "The in-flight paymaster transaction completed successfully.",
          });
          updateDepositLog("reconcile", {
            status: "done",
            detail:
              "Duplicate paymaster response reconciled from private balance discovery.",
          });
          return;
        }
      } catch {
        // Preserve the original bridge error if reconciliation also fails.
      }
      setStage("idle");
      updateDepositLog("reconcile", {
        status: isAmbiguousPaymasterSubmissionError(reason)
          ? "running"
          : "error",
        detail: errorMessage(reason),
      });
      setError(errorMessage(reason));
    }
  }

  async function withdraw() {
    const amount = usdcBaseUnits(depositAmount);
    if (
      amount <= 0n ||
      amount > privateBalance ||
      !/^0x[0-9a-fA-F]{40}$/.test(withdrawDestination) ||
      busy
    ) {
      return;
    }
    setError(undefined);
    setBalanceStep(undefined);
    try {
      await prepareFreshIdentity();
      await runtime.withdraw(
        amount,
        withdrawDestination as PrivateLaunchpadSession["account"],
        (step, status) => {
          if (status === "running") setBalanceStep(step);
        },
      );
      setPrivateBalance((balance) => balance - amount);
      setStage("idle");
      setBalanceModal(undefined);
      setBalanceStep(undefined);
      runtime.reset();
      setIdentity(undefined);
    } catch (reason) {
      setStage("idle");
      setError(errorMessage(reason));
    }
  }

  async function positionContext(): Promise<{
    rootAddress: PrivateLaunchpadSession["account"];
    knownPositions: PrivatePosition[];
  }> {
    if (connectedWallet) {
      return { rootAddress: connectedWallet, knownPositions: positions };
    }
    const prepared = await runtime.prepareIdentity(0);
    rememberStorageScope(prepared);
    const rootAddress = prepared.connectedAddress;
    setConnectedWallet(rootAddress);
    setIdentity(prepared);
    return {
      rootAddress,
      knownPositions: restorePositions(rootAddress),
    };
  }

  async function launch() {
    if (!launchValid || busy || launchInFlight.current) return;
    launchInFlight.current = true;
    let rootAddress: PrivateLaunchpadSession["account"] | undefined;
    let positionId: string | undefined;
    let fundingDelivered = false;
    let launchedToken: PrivateLaunchpadSession["account"] | undefined;
    let launchHash: string | undefined;
    let buyHash: string | undefined;
    let launchConfirmed = false;
    setError(undefined);
    setReturnResult(undefined);
    setLastTrade(undefined);
    try {
      const context = await positionContext();
      rootAddress = context.rootAddress;
      const accountIndex = allocateAccountIndex(context.knownPositions);
      const prepared = await prepareFreshIdentity(accountIndex);
      positionId = createPositionId();
      setActivePositionId(positionId);
      const now = Date.now();
      commitPosition(rootAddress, {
        id: positionId,
        kind: "launch",
        name: launchDraft.name,
        symbol: launchDraft.symbol,
        accountIndex,
        account: prepared.session.account,
        status: "funding",
        usdcCommitted: launchDraft.bridgeAmount.toString(),
        createdAt: now,
        updatedAt: now,
      });
      setStage("funding");
      const result = await runtime.fund(launchDraft);
      const fundedIdentity = reconcileFundedIdentity(prepared, result);
      const executableAmount =
        result.minimumAmountDelivered ??
        result.amountDelivered ??
        launchDraft.bridgeAmount;
      if (executableAmount <= 0n) {
        throw new Error("The private bridge delivered no spendable USDG");
      }
      fundingDelivered = true;
      setFunding(result);
      setPrivateBalance((balance) => balance - launchDraft.bridgeAmount);
      patchPosition(rootAddress, positionId, {
        status: "launching",
        accountIndex: fundedIdentity.session.accountIndex,
        account: fundedIdentity.session.account,
        usdcCommitted: executableAmount.toString(),
      });
      setStage("executing");
      const launched = await runtime.launch(launchDraft);
      launchHash = launched.transactionHash;
      launchedToken = launched.token;
      setToken(launched.token);
      setTransactionHash(launched.transactionHash);
      patchPosition(rootAddress, positionId, {
        status: "launching",
        token: launched.token,
        launchTxHash: launched.transactionHash,
      });
      const confirmation = await runtime.waitForTransaction(
        launched.transactionHash,
      );
      if (confirmation.status === "reverted") {
        const message =
          "The Pons launch reverted. The private USDG remains in the fresh account and can be returned.";
        patchPosition(rootAddress, positionId, {
          status: "failed",
          lastError: message,
        });
        setError(message);
        setStage("complete");
        return;
      }
      launchConfirmed = true;

      patchPosition(rootAddress, positionId, { status: "buying" });
      const creatorBuy = await runtime.buy({
        token: launched.token,
        amountIn: executableAmount,
        slippageBps: 100,
      });
      buyHash = creatorBuy.transactionHash;
      setLastTrade(creatorBuy);
      setTransactionHash(creatorBuy.transactionHash);
      patchPosition(rootAddress, positionId, {
        status: "buying",
        buyTxHash: creatorBuy.transactionHash,
      });
      const buyConfirmation = await runtime.waitForTransaction(
        creatorBuy.transactionHash,
      );
      if (buyConfirmation.status === "reverted") {
        const message =
          "The token launched, but the creator buy reverted. Retry the buy or return the USDC from Positions.";
        patchPosition(rootAddress, positionId, {
          status: "buy-failed",
          lastError: message,
        });
        setError(message);
        setStage("complete");
        return;
      }
      patchPosition(rootAddress, positionId, {
        status: "held",
        tokenAmount: creatorBuy.amountOut.toString(),
        lastError: undefined,
      });
      setStage("complete");
    } catch (reason) {
      const message = errorMessage(reason);
      if (rootAddress && positionId) {
        patchPosition(rootAddress, positionId, {
          status: launchConfirmed
            ? "buy-failed"
            : launchHash
              ? "launching"
              : "failed",
          ...(launchedToken ? { token: launchedToken } : {}),
          ...(launchHash ? { launchTxHash: launchHash } : {}),
          ...(buyHash ? { buyTxHash: buyHash } : {}),
          lastError: message,
        });
      }
      if (launchHash || buyHash || fundingDelivered) {
        setStage("complete");
        setError(message);
      } else {
        setStage("idle");
        setError(message);
      }
    } finally {
      launchInFlight.current = false;
    }
  }

  async function trade() {
    if (!tradeValid || busy) return;
    let rootAddress: PrivateLaunchpadSession["account"] | undefined;
    let positionId: string | undefined;
    let fundingDelivered = false;
    let sellConfirmed = false;
    setError(undefined);
    setReturnResult(undefined);
    setLastTrade(undefined);
    if (tradeSide === "buy") {
      beginExecutionLog(
        "Private buy",
        tradeDraft.amountIn,
        selectedMarket.symbol,
      );
    }
    try {
      if (tradeSide === "buy") {
        const context = await positionContext();
        rootAddress = context.rootAddress;
        const accountIndex = allocateAccountIndex(context.knownPositions);
        const prepared = await prepareFreshIdentity(accountIndex);
        updateExecutionLog("identity", {
          status: "done",
          detail: `Fresh account ${shorten(prepared.session.account, 10, 8)} prepared. Secret key material was not logged.`,
        });
        updateExecutionLog("execution", {
          status: "running",
          detail:
            "Checking that this token is still on a live Pons bonding curve before moving private funds.",
        });
        await runtime.quoteBuy(prepared.session.account, tradeDraft);
        updateExecutionLog("execution", {
          status: "pending",
          detail:
            "Live Pons curve confirmed. Execution will be quoted again after funding.",
        });
        positionId = createPositionId();
        setActivePositionId(positionId);
        const now = Date.now();
        commitPosition(rootAddress, {
          id: positionId,
          kind: "trade",
          name: selectedMarket.name,
          symbol: selectedMarket.symbol,
          token: tradeDraft.token,
          accountIndex,
          account: prepared.session.account,
          status: "funding",
          usdcCommitted: tradeDraft.amountIn.toString(),
          createdAt: now,
          updatedAt: now,
        });
        const fundingDraft: LaunchDraft = {
          name: "Pons buy",
          symbol: "BUY",
          bridgeAmount: tradeDraft.amountIn,
          creatorReward: 0,
          salt: createLaunchSalt(),
        };
        setStage("funding");
        const fundingResult = await runtime.fund(
          fundingDraft,
          (step, status, detail) => {
            const loggerStep: ExecutionLogId =
              step === "relay" ? "funding-relay" : "bridge";
            updateExecutionLog(loggerStep, {
              status,
              detail:
                detail ??
                (status === "done"
                  ? "Funding stage completed."
                  : "Funding stage is in progress."),
            });
          },
        );
        const fundedIdentity = reconcileFundedIdentity(prepared, fundingResult);
        const executableAmount =
          fundingResult.minimumAmountDelivered ??
          fundingResult.amountDelivered ??
          tradeDraft.amountIn;
        if (executableAmount <= 0n) {
          throw new Error("The private bridge delivered no spendable USDG");
        }
        setFunding(fundingResult);
        fundingDelivered = true;
        setPrivateBalance((balance) => balance - tradeDraft.amountIn);
        patchPosition(rootAddress, positionId, {
          status: "buying",
          accountIndex: fundedIdentity.session.accountIndex,
          account: fundedIdentity.session.account,
          usdcCommitted: executableAmount.toString(),
        });
        setStage("executing");
        updateExecutionLog("execution", {
          status: "running",
          detail:
            "Requesting the Pons curve quote, signing the fresh-account call batch, and submitting it to the policy relayer.",
        });
        const bought = await runtime.buy({
          ...tradeDraft,
          amountIn: executableAmount,
        });
        updateExecutionLog("execution", {
          status: "done",
          detail: "The policy relayer accepted and broadcast the buy.",
          transactionHash: bought.transactionHash,
          explorerUrl: `${ROBINHOOD_EXPLORER_URL}/tx/${bought.transactionHash}`,
        });
        setLastTrade(bought);
        setTransactionHash(bought.transactionHash);
        patchPosition(rootAddress, positionId, {
          status: "buying",
          buyTxHash: bought.transactionHash,
        });
        updateExecutionLog("confirmation", {
          status: "running",
          detail: "Broadcast complete · waiting for a Robinhood block receipt.",
          transactionHash: bought.transactionHash,
          explorerUrl: `${ROBINHOOD_EXPLORER_URL}/tx/${bought.transactionHash}`,
        });
        const confirmation = await runtime.waitForTransaction(
          bought.transactionHash,
        );
        if (confirmation.status === "reverted") {
          updateExecutionLog("confirmation", {
            status: "error",
            detail: `The buy reverted in Robinhood block ${confirmation.blockNumber.toLocaleString()}.`,
          });
          throw new Error(
            "The buy reverted. Your USDC remains in the fresh account; retry or return it from Positions.",
          );
        }
        updateExecutionLog("confirmation", {
          status: "done",
          detail: `Confirmed successfully in Robinhood block ${confirmation.blockNumber.toLocaleString()}.`,
        });
        updateExecutionLog("reconcile", {
          status: "running",
          detail:
            "Recording the received token balance for this fresh account.",
        });
        patchPosition(rootAddress, positionId, {
          status: "held",
          tokenAmount: bought.amountOut.toString(),
          lastError: undefined,
        });
        updateExecutionLog("reconcile", {
          status: "done",
          detail: `${formatTokenAmount(bought.amountOut)} $${selectedMarket.symbol} recorded in the onchain-separated position.`,
        });
        setStage("complete");
      } else {
        if (!activePosition?.token || !connectedWallet) {
          throw new Error("Select a saved position before selling");
        }
        rootAddress = connectedWallet;
        positionId = activePosition.id;
        await prepareFreshIdentity(activePosition.accountIndex);
        const fullBalance = await runtime.readTokenBalance(
          activePosition.token,
        );
        if (fullBalance <= 0n) {
          throw new Error("This fresh account no longer holds the token");
        }
        patchPosition(rootAddress, positionId, {
          status: "selling",
          tokenAmount: fullBalance.toString(),
        });
        setStage("executing");
        const sold = await runtime.sell({
          token: activePosition.token,
          amountIn: fullBalance,
          slippageBps: tradeDraft.slippageBps,
        });
        setLastTrade(sold);
        setTransactionHash(sold.transactionHash);
        patchPosition(rootAddress, positionId, {
          status: "selling",
          sellTxHash: sold.transactionHash,
        });
        const confirmation = await runtime.waitForTransaction(
          sold.transactionHash,
        );
        if (confirmation.status === "reverted") {
          patchPosition(rootAddress, positionId, { status: "held" });
          throw new Error(
            "The sell reverted. Your token position is still held.",
          );
        }
        sellConfirmed = true;
        patchPosition(rootAddress, positionId, {
          status: "returning",
          tokenAmount: "0",
        });
        setStage("returning");
        const returned = await runtime.returnToPool();
        setReturnResult(returned);
        setPrivateBalance((balance) => balance + returned.amountReturned);
        patchPosition(rootAddress, positionId, {
          status: "closed",
          lastError: undefined,
        });
        setStage("complete");
      }
    } catch (reason) {
      const message = errorMessage(reason);
      if (tradeSide === "buy") failExecutionLog(message);
      if (rootAddress && positionId) {
        patchPosition(rootAddress, positionId, {
          status:
            tradeSide === "buy"
              ? fundingDelivered
                ? "buy-failed"
                : "failed"
              : sellConfirmed
                ? "return-failed"
                : "held",
          lastError: message,
        });
      }
      setStage(fundingDelivered || sellConfirmed ? "complete" : "idle");
      setError(message);
    }
  }

  async function returnPosition(position: PrivatePosition) {
    if (!connectedWallet || busy) return;
    setError(undefined);
    try {
      setActivePositionId(position.id);
      await prepareFreshIdentity(position.accountIndex);
      patchPosition(connectedWallet, position.id, {
        status: "returning",
      });
      setStage("returning");
      const returned = await runtime.returnToPool();
      setReturnResult(returned);
      setPrivateBalance((balance) => balance + returned.amountReturned);
      patchPosition(connectedWallet, position.id, {
        status: "closed",
        lastError: undefined,
      });
      setStage("complete");
    } catch (reason) {
      patchPosition(connectedWallet, position.id, {
        status: "return-failed",
        lastError: errorMessage(reason),
      });
      setStage("complete");
      setError(errorMessage(reason));
    }
  }

  async function returnUnusedBudget() {
    if (!activePosition) return;
    await returnPosition(activePosition);
  }

  async function retryPositionBuy(position: PrivatePosition) {
    if (!connectedWallet || !position.token || busy) return;
    setActivePositionId(position.id);
    setToken(position.token);
    setError(undefined);
    setReturnResult(undefined);
    setLastTrade(undefined);
    beginExecutionLog(
      "Retry buy",
      BigInt(position.usdcCommitted),
      position.symbol,
      true,
    );
    try {
      const prepared = await prepareFreshIdentity(position.accountIndex);
      updateExecutionLog("identity", {
        status: "done",
        detail: `Recovered fresh account ${shorten(prepared.session.account, 10, 8)}. No private funds will be bridged again.`,
      });
      patchPosition(connectedWallet, position.id, { status: "buying" });
      setStage("executing");
      updateExecutionLog("execution", {
        status: "running",
        detail:
          "Requoting the Pons curve and submitting the existing fresh-account USDC to the policy relayer.",
      });
      const bought = await runtime.buy({
        token: position.token,
        amountIn: BigInt(position.usdcCommitted),
        slippageBps: 100,
      });
      updateExecutionLog("execution", {
        status: "done",
        detail: "The policy relayer accepted and broadcast the retry.",
        transactionHash: bought.transactionHash,
        explorerUrl: `${ROBINHOOD_EXPLORER_URL}/tx/${bought.transactionHash}`,
      });
      setLastTrade(bought);
      setTransactionHash(bought.transactionHash);
      patchPosition(connectedWallet, position.id, {
        status: "buying",
        buyTxHash: bought.transactionHash,
      });
      updateExecutionLog("confirmation", {
        status: "running",
        detail: "Broadcast complete · waiting for a Robinhood block receipt.",
        transactionHash: bought.transactionHash,
        explorerUrl: `${ROBINHOOD_EXPLORER_URL}/tx/${bought.transactionHash}`,
      });
      const confirmation = await runtime.waitForTransaction(
        bought.transactionHash,
      );
      if (confirmation.status === "reverted") {
        updateExecutionLog("confirmation", {
          status: "error",
          detail: `The retry reverted in Robinhood block ${confirmation.blockNumber.toLocaleString()}.`,
        });
        throw new Error(
          "The retry buy reverted. The USDC remains recoverable.",
        );
      }
      updateExecutionLog("confirmation", {
        status: "done",
        detail: `Confirmed successfully in Robinhood block ${confirmation.blockNumber.toLocaleString()}.`,
      });
      updateExecutionLog("reconcile", {
        status: "running",
        detail: "Recording the received token balance for this fresh account.",
      });
      patchPosition(connectedWallet, position.id, {
        status: "held",
        tokenAmount: bought.amountOut.toString(),
        lastError: undefined,
      });
      updateExecutionLog("reconcile", {
        status: "done",
        detail: `${formatTokenAmount(bought.amountOut)} $${position.symbol} recorded in the onchain-separated position.`,
      });
      setTradeSide("sell");
      setStage("complete");
    } catch (reason) {
      const message = errorMessage(reason);
      failExecutionLog(message);
      patchPosition(connectedWallet, position.id, {
        status: "buy-failed",
        lastError: message,
      });
      setError(message);
      setStage("complete");
    }
  }

  function openSavedPosition(position: PrivatePosition) {
    if (busy) return;
    runtime.reset();
    setActivePositionId(position.id);
    if (position.token) {
      setToken(position.token);
      const knownMarket = markets.find(
        (market) =>
          market.token.toLowerCase() === position.token?.toLowerCase(),
      );
      if (knownMarket) setSelectedMarket(knownMarket);
      else {
        setSelectedMarket({
          name: position.name,
          symbol: position.symbol,
          token: position.token,
          description: "A saved private Pons position.",
          marketCap: "Onchain",
          volume: "Saved position",
          age: "saved",
          version: "V2",
          glyph: position.symbol.slice(0, 1) || "P",
          art: "night",
          progress: 50,
        });
      }
    }
    const liveBalance = portfolioSnapshots[position.id]?.tokenBalance ?? 0n;
    setTradeSide(
      position.status === "held" || liveBalance > 0n ? "sell" : "buy",
    );
    setIdentity(undefined);
    setFunding(undefined);
    setReturnResult(undefined);
    setTransactionHash(
      position.sellTxHash ?? position.buyTxHash ?? position.launchTxHash,
    );
    setLastTrade(undefined);
    setError(
      position.lastError
        ? errorMessage(new Error(position.lastError))
        : undefined,
    );
    setStage("idle");
    setWorkspace("trade");
  }

  async function recoverPosition(position: PrivatePosition) {
    if (!connectedWallet || busy) return;
    setActivePositionId(position.id);
    if (position.token) setToken(position.token);
    setError(undefined);
    try {
      await prepareFreshIdentity(position.accountIndex);
      const transactionHash =
        position.status === "selling"
          ? position.sellTxHash
          : position.status === "buying"
            ? position.buyTxHash
            : position.launchTxHash;
      if (!transactionHash) {
        patchPosition(connectedWallet, position.id, {
          status: "failed",
          lastError:
            "No Robinhood transaction was recorded. Return any USDG that reached this account.",
        });
        setStage("complete");
        return;
      }

      setTransactionHash(transactionHash);
      setStage("executing");
      const confirmation = await runtime.waitForTransaction(transactionHash);
      if (confirmation.status === "reverted") {
        patchPosition(connectedWallet, position.id, {
          status:
            position.status === "selling"
              ? "held"
              : position.status === "launching"
                ? "failed"
                : "buy-failed",
          lastError: "The recorded Robinhood transaction reverted.",
        });
        setError("The recorded Robinhood transaction reverted.");
        setStage("complete");
        return;
      }

      if (position.status === "selling") {
        patchPosition(connectedWallet, position.id, {
          status: "returning",
          tokenAmount: "0",
        });
        await returnPosition(position);
        return;
      }
      if (position.status === "buying" && position.token) {
        const balance = await runtime.readTokenBalance(position.token);
        if (balance > 0n) {
          patchPosition(connectedWallet, position.id, {
            status: "held",
            tokenAmount: balance.toString(),
            lastError: undefined,
          });
          setTradeSide("sell");
          setStage("complete");
          return;
        }
      }
      patchPosition(connectedWallet, position.id, {
        status: "buy-failed",
        lastError: undefined,
      });
      setStage("complete");
    } catch (reason) {
      const message = errorMessage(reason);
      patchPosition(connectedWallet, position.id, { lastError: message });
      setError(message);
      setStage("complete");
    }
  }

  function startAnother() {
    runtime.reset();
    setStage("idle");
    setIdentity(undefined);
    setFunding(undefined);
    setReturnResult(undefined);
    setTransactionHash(undefined);
    setLastTrade(undefined);
    setError(undefined);
    setActivePositionId(undefined);
    setLaunchSalt(createLaunchSalt());
    if (workspace === "trade") setTradeSide("buy");
  }

  const busyLabel = busy
    ? stage === "executing" && transactionHash
      ? "Confirming on Robinhood"
      : routeLabels[stage as keyof typeof routeLabels]
    : undefined;

  return (
    <div className="clanker-page" data-theme={theme}>
      {workspace !== "launch" && (
        <header className="top-nav pons-nav">
          <div className="pons-nav-inner">
            <button
              className="pons-brand"
              type="button"
              aria-label="PonsButPrivate home"
              onClick={() => switchWorkspace("explore")}
            >
              <span className="pons-brand-copy">PonsButPrivate</span>
            </button>

            <nav className="pons-product-nav" aria-label="Product navigation">
              <button
                className={workspace === "explore" ? "active" : ""}
                onClick={() => switchWorkspace("explore")}
              >
                Explore
              </button>
              <button onClick={() => switchWorkspace("launch")}>Create</button>
              <button
                className={workspace === "positions" ? "active" : ""}
                onClick={() => switchWorkspace("positions")}
              >
                Positions
              </button>
            </nav>

            <div className="nav-actions pons-nav-actions">
              <span className="pons-private-balance">
                <LockKeyIcon size={13} weight="fill" aria-hidden="true" />
                {formatUsdc(privateBalanceAvailable)} USDC
              </span>
              <button
                className="pons-deposit-nav"
                type="button"
                onClick={() => setBalanceModal("deposit")}
              >
                Deposit
              </button>
              <button
                className="pons-process-nav"
                type="button"
                data-active={processEntries.length > 0}
                aria-label="Open transaction process log"
                onClick={() => {
                  if (executionLog.length > 0) {
                    setTransactionMonitorView("execution");
                  }
                  setTransactionMonitorOpen(true);
                }}
              >
                <ListDashesIcon
                  className="pons-process-icon"
                  size={18}
                  weight="duotone"
                  aria-hidden="true"
                />
                <i data-status={processStatus} />
                <span className="pons-process-label">Tx log</span>
              </button>
              <button
                className="nav-icon"
                aria-label="Toggle color theme"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                {theme === "dark" ? (
                  <SunIcon size={15} weight="duotone" aria-hidden="true" />
                ) : (
                  <MoonIcon size={15} weight="duotone" aria-hidden="true" />
                )}
              </button>
              {runtime.mode === "live" ? (
                <button
                  className="wallet-connect"
                  type="button"
                  data-connected={!!connectedWallet}
                  disabled={walletConnecting || busy}
                  aria-label={
                    connectedWallet
                      ? `MetaMask connected: ${connectedWallet}`
                      : "Connect MetaMask"
                  }
                  onClick={connectEvmWallet}
                >
                  <WalletIcon
                    className="wallet-connect-icon"
                    size={14}
                    weight="duotone"
                    aria-hidden="true"
                  />
                  <span>
                    {walletConnecting
                      ? "Restoring…"
                      : connectedWallet
                        ? shorten(connectedWallet)
                        : "Connect"}
                  </span>
                </button>
              ) : (
                <span className="wallet-preview">
                  <WalletIcon size={14} weight="duotone" aria-hidden="true" />
                  Preview wallet
                </span>
              )}
            </div>
          </div>
        </header>
      )}

      <nav className="pons-mobile-dock" aria-label="Mobile navigation">
        <button
          type="button"
          aria-label="Browse markets"
          data-active={workspace === "explore"}
          aria-current={workspace === "explore" ? "page" : undefined}
          onClick={() => switchWorkspace("explore")}
        >
          <MagnifyingGlassIcon size={18} weight="duotone" aria-hidden="true" />
          <span>Explore</span>
        </button>
        <button
          type="button"
          aria-label="Open token launcher"
          data-active={workspace === "launch"}
          aria-current={workspace === "launch" ? "page" : undefined}
          onClick={() => switchWorkspace("launch")}
        >
          <RocketLaunchIcon size={18} weight="duotone" aria-hidden="true" />
          <span>Create</span>
        </button>
        <button
          type="button"
          aria-label="Open portfolio"
          data-active={workspace === "positions"}
          aria-current={workspace === "positions" ? "page" : undefined}
          onClick={() => switchWorkspace("positions")}
        >
          <VaultIcon size={18} weight="duotone" aria-hidden="true" />
          <span>Positions</span>
        </button>
        <button
          type="button"
          aria-label="Open private balance"
          data-active={balanceModal === "deposit"}
          aria-haspopup="dialog"
          onClick={() => setBalanceModal("deposit")}
        >
          <CoinsIcon size={18} weight="duotone" aria-hidden="true" />
          <span>Deposit</span>
        </button>
      </nav>

      {walletError && (
        <div className="wallet-error-strip" role="alert">
          <span>{walletError}</span>
          <button
            type="button"
            aria-label="Dismiss wallet error"
            onClick={() => setWalletError(undefined)}
          >
            ×
          </button>
        </div>
      )}

      <main id="top" className="page-content">
        <section
          className={`terminal-shell ${workspace === "launch" ? "deploy-terminal" : ""} ${workspace === "explore" ? "pons-explore-shell" : ""} ${workspace === "trade" ? "pons-token-shell" : ""} ${workspace === "positions" ? "pons-positions-shell" : ""}`}
          aria-label="PonsButPrivate app"
        >
          {workspace === "explore" && (
            <section className="pons-explore" aria-labelledby="explore-title">
              <div className="pons-search-row">
                <label className="pons-market-search">
                  <MagnifyingGlassIcon size={18} aria-hidden="true" />
                  <input
                    value={marketSearch}
                    placeholder="Search tokens or paste a token address"
                    aria-label="Search tokens"
                    onChange={(event) => setMarketSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") openSearchedAddress();
                    }}
                  />
                  <kbd>⌘K</kbd>
                </label>
                <button
                  className="pons-create-button"
                  type="button"
                  aria-label="Create token"
                  onClick={() => switchWorkspace("launch")}
                >
                  <span aria-hidden="true">＋</span> Create
                </button>
              </div>

              <section
                className="pons-market-panel pons-graduated-panel"
                aria-labelledby="graduated-title"
              >
                <header className="pons-market-toolbar">
                  <div>
                    <div className="pons-market-title-row">
                      <h2 id="graduated-title">Graduated</h2>
                      <span className="pons-market-count">
                        {graduatedCount.toLocaleString()}
                      </span>
                    </div>
                    <p>Tokens that cleared the graduation threshold.</p>
                  </div>
                </header>
                <div className="pons-market-grid">
                  {graduatedMarkets.map((market) => (
                    <button
                      className="pons-market-card pons-graduated-card"
                      type="button"
                      key={market.token}
                      onClick={() => openGraduatedMarket(market)}
                    >
                      <GraduatedArtwork market={market} />
                      <span className="pons-market-copy">
                        <span className="pons-market-name">
                          <b>{market.name}</b>
                          <small>${market.symbol}</small>
                        </span>
                        <span className="pons-market-value pons-graduated-value">
                          {formatUsdCompact(
                            market.realMcapUsd ?? market.marketCapUsd,
                          )}{" "}
                          <small>MC</small>
                          {market.realMcapUsd != null &&
                            market.marketCapUsd > market.realMcapUsd && (
                              <small>
                                {" "}
                                / {formatUsdCompact(market.marketCapUsd)} FDV
                              </small>
                            )}
                        </span>
                        <span className="pons-market-meta">
                          <small>{shorten(market.deployer)}</small>
                          <small>
                            {formatMarketAge(
                              market.graduatedAt ?? market.launchedAt,
                            )}
                          </small>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="pons-market-panel">
                <header className="pons-market-toolbar">
                  <div>
                    <div className="pons-market-title-row">
                      <h1 id="explore-title">Explore</h1>
                      <span className="pons-market-count">
                        {launchCount.toLocaleString()} launched
                      </span>
                    </div>
                    <p>
                      Tokens still climbing toward graduation on Robinhood
                      Chain.
                    </p>
                  </div>
                  <div className="pons-market-filters">
                    <div className="pons-filter-pills" aria-label="Market sort">
                      {(
                        [
                          ["recent", "Recent buys"],
                          ["newest", "Newest"],
                          ["oldest", "Oldest"],
                          ["market-cap", "Market cap"],
                          ["volume", "Volume"],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          className={marketSort === value ? "active" : ""}
                          key={value}
                          onClick={() => setMarketSort(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="pons-filter-pills" aria-label="Market age">
                      {(["all", "24h", "7d"] as const).map((value) => (
                        <button
                          className={marketAge === value ? "active" : ""}
                          key={value}
                          onClick={() => setMarketAge(value)}
                        >
                          {value === "all" ? "All" : value}
                        </button>
                      ))}
                    </div>
                    <div
                      className="pons-filter-pills"
                      aria-label="Market version"
                    >
                      {(["both", "v1", "v2"] as const).map((value) => (
                        <button
                          className={marketVersion === value ? "active" : ""}
                          key={value}
                          onClick={() => setMarketVersion(value)}
                        >
                          {value === "both" ? "Both" : value}
                        </button>
                      ))}
                    </div>
                  </div>
                </header>

                {visibleMarkets.length > 0 ? (
                  <div className="pons-market-grid">
                    {visibleMarkets.map((market, index) => (
                      <button
                        className="pons-market-card"
                        type="button"
                        key={`${market.name}-${index}`}
                        onClick={() => openMarket(market)}
                      >
                        <MarketArtwork market={market} />
                        <span className="pons-market-copy">
                          <span className="pons-market-name">
                            <b>{market.name}</b>
                            <small>${market.symbol}</small>
                          </span>
                          <span className="pons-market-value">
                            {market.marketCap} <small>MC</small>
                          </span>
                          <span className="pons-market-progress">
                            <i style={{ width: `${market.progress}%` }} />
                          </span>
                          <span className="pons-market-meta">
                            <small>{shorten(market.token)}</small>
                            <small>{market.age}</small>
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="pons-market-empty">
                    <strong>No matching markets</strong>
                    <span>Try a name, symbol, or full token address.</span>
                  </div>
                )}
              </section>

              <div className="pons-private-note">
                <span>
                  PonsButPrivate is an independent product and is not affiliated
                  with Pons. It uses Pons tokens and routes funds through STRK20
                  before funding a fresh Robinhood address for the public
                  purchase.
                </span>
              </div>
            </section>
          )}

          {workspace === "launch" && (
            <section
              className="workspace pons-launch-workspace"
              aria-labelledby="launch-title"
            >
              <header className="pons-launch-topbar">
                <button
                  className="pons-launch-back"
                  type="button"
                  onClick={() => switchWorkspace("explore")}
                >
                  <span aria-hidden="true">‹</span> Back
                </button>
                <div className="pons-launch-version" aria-label="Pons version">
                  <button type="button" data-active="true">
                    v2
                  </button>
                  <button
                    type="button"
                    aria-disabled="true"
                    title="Private launches currently use the Pons V2 adapter"
                  >
                    v1
                  </button>
                </div>
              </header>

              <div className="pons-launch-shell">
                <div className="pons-launch-form">
                  <h1 id="launch-title">Launch token</h1>

                  <div className="pons-launch-two-up">
                    <label className="pons-launch-field">
                      <span>Name</span>
                      <input
                        value={name}
                        maxLength={40}
                        placeholder="Token name"
                        disabled={busy || stage === "complete"}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </label>
                    <label className="pons-launch-field">
                      <span>Ticker</span>
                      <input
                        value={symbol}
                        maxLength={10}
                        placeholder="symbol"
                        disabled={busy || stage === "complete"}
                        onChange={(event) =>
                          setSymbol(event.target.value.toUpperCase())
                        }
                      />
                    </label>
                  </div>

                  <label className="pons-launch-field">
                    <span>Description</span>
                    <textarea
                      value={description}
                      maxLength={180}
                      placeholder="A short description of the token"
                      disabled={busy || stage === "complete"}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </label>

                  <label className="pons-launch-field">
                    <span>Token image</span>
                    <input
                      ref={tokenImageInput}
                      className="token-image-input"
                      type="file"
                      accept=".jpg,.jpeg,.png,image/jpeg,image/png"
                      aria-label="Token image"
                      disabled={busy || stage === "complete"}
                      onChange={selectTokenImage}
                    />
                    <button
                      className={`pons-launch-upload${tokenImagePreview ? " has-preview" : ""}`}
                      type="button"
                      aria-label={
                        tokenImagePreview
                          ? "Change token image"
                          : "Upload image"
                      }
                      disabled={busy || stage === "complete"}
                      onClick={() => tokenImageInput.current?.click()}
                    >
                      <span className="pons-launch-upload-icon">
                        {tokenImagePreview ? (
                          <img
                            src={tokenImagePreview}
                            alt="Selected token artwork"
                          />
                        ) : (
                          <ImageIcon
                            size={18}
                            weight="duotone"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      <span>
                        <b>
                          {tokenImagePreview ? "Change image" : "Choose image"}
                        </b>
                        {tokenImageName && <small>{tokenImageName}</small>}
                      </span>
                    </button>
                    {tokenImageError && (
                      <small className="token-image-error" role="alert">
                        {tokenImageError}
                      </small>
                    )}
                  </label>

                  <div className="pons-launch-two-up">
                    <label className="pons-launch-field">
                      <span>X profile</span>
                      <input
                        value={xProfile}
                        placeholder="x.com/handle"
                        disabled={busy || stage === "complete"}
                        onChange={(event) => setXProfile(event.target.value)}
                      />
                    </label>
                    <label className="pons-launch-field">
                      <span>Telegram</span>
                      <input
                        value={telegram}
                        placeholder="t.me/community"
                        disabled={busy || stage === "complete"}
                        onChange={(event) => setTelegram(event.target.value)}
                      />
                    </label>
                  </div>

                  <label className="pons-launch-field">
                    <span>Paired asset</span>
                    <button className="pons-launch-asset-select" type="button">
                      <span>
                        <img src={USDG_ICON_URL} alt="" />
                        <b>USDG</b>
                      </span>
                      <CaretDownIcon size={13} aria-hidden="true" />
                    </button>
                    <small>
                      Graduates according to the live Pons USDG curve.
                    </small>
                  </label>

                  <label className="pons-launch-field">
                    <span>Developer buy</span>
                    <span className="pons-launch-buy-field">
                      <input
                        aria-label="Developer buy"
                        type="number"
                        min="1"
                        step="0.01"
                        value={launchBudget}
                        disabled={busy || stage === "complete"}
                        onFocus={(event) => event.currentTarget.select()}
                        onChange={(event) =>
                          setLaunchBudget(Number(event.target.value))
                        }
                      />
                      <span>
                        <img src={USDG_ICON_URL} alt="" /> USDG
                      </span>
                      <small>
                        {runtime.mode === "live" && !connectedWallet
                          ? "Balance unavailable"
                          : `${formatUsdc(privateBalanceAvailable)} available privately`}
                      </small>
                    </span>
                  </label>

                  <details className="pons-launch-advanced">
                    <summary>
                      <span>Advanced</span>
                      <CaretDownIcon size={13} aria-hidden="true" />
                    </summary>
                    <div className="pons-launch-advanced-body">
                      <section
                        className="droid-panel privacy-launch-panel"
                        data-enabled={privateLaunchEnabled}
                      >
                        <div className="droid-header">
                          <div>
                            <span className="row-icon purple">
                              <LockKeyIcon
                                size={15}
                                weight="duotone"
                                aria-hidden="true"
                              />
                            </span>
                            <b>Private launch through STRK20</b>
                          </div>
                          <button
                            className="toggle"
                            type="button"
                            role="switch"
                            aria-label="Private launch"
                            aria-checked={privateLaunchEnabled}
                            data-active={privateLaunchEnabled}
                            disabled={busy || stage === "complete"}
                            onClick={() =>
                              setPrivateLaunchEnabled((enabled) => !enabled)
                            }
                          />
                        </div>
                        <p className="droid-description">
                          STRK20 funds a one-time Robinhood account so the
                          launcher’s original wallet is not linked onchain to
                          the Pons execution account. The browser and routing
                          providers can still correlate the flow. It deploys the
                          token and makes the initial creator buy.
                        </p>
                        <div
                          className="privacy-deposit-state"
                          data-ready={privateRouteReady}
                          data-disabled={!privateLaunchEnabled}
                          aria-live="polite"
                        >
                          <span
                            className="privacy-status-icon"
                            aria-hidden="true"
                          >
                            {!privateLaunchEnabled
                              ? "—"
                              : privateRouteReady
                                ? "✓"
                                : "$"}
                          </span>
                          <span className="privacy-status-copy">
                            <b>
                              {!privateLaunchEnabled
                                ? "Private route off"
                                : transactionHash
                                  ? "Token launched"
                                  : launchFundsCommitted
                                    ? "Private USDC sent"
                                    : privateFundingResting
                                      ? "Private funds are resting"
                                      : privateFundingReady
                                        ? "USDC is private"
                                        : "Fund your private balance"}
                            </b>
                            <small>
                              {!privateLaunchEnabled
                                ? "Turn it on to launch from an onchain-separated account"
                                : runtime.mode === "live" && !connectedWallet
                                  ? "MetaMask connects to Robinhood first"
                                  : privateFundingResting
                                    ? `Available for launch in ${formatWait(privacyWaitRemaining)}`
                                    : privateFundingReady &&
                                        !launchFundsCommitted
                                      ? `${formatUsdc(privateBalanceAvailable)} USDC available in STRK20`
                                      : launchFundsCommitted
                                        ? "The separated Robinhood account is funded"
                                        : `Deposit a common ${launchBudget} USDC amount to continue`}
                            </small>
                          </span>
                          {!privateLaunchEnabled ? (
                            <strong className="privacy-off-label">Off</strong>
                          ) : privateFundingResting ? (
                            <strong className="privacy-wait-label">
                              {formatWait(privacyWaitRemaining)}
                            </strong>
                          ) : privateRouteReady ? (
                            <strong className="privacy-ready-label">
                              {transactionHash ? "Done" : "Ready"}
                            </strong>
                          ) : (
                            <button
                              className="privacy-deposit-button"
                              type="button"
                              aria-label="Deposit to STRK20"
                              disabled={busy}
                              onClick={openLaunchDeposit}
                            >
                              Deposit
                            </button>
                          )}
                        </div>
                      </section>

                      <AnimatedSettingRow
                        icon={<SealPercentIcon size={15} weight="duotone" />}
                        title="Fees"
                        description="1% static · 1% sniper tax"
                      >
                        <div className="details-body token-setting-grid">
                          <span>Pool fee</span>
                          <b>1% static</b>
                          <span>Sniper tax</span>
                          <b>1% at launch</b>
                        </div>
                      </AnimatedSettingRow>

                      <div
                        className="amount-presets pool-presets"
                        role="group"
                        aria-label="Common position budget"
                      >
                        {COMMON_USDC_AMOUNTS.map((amount) => (
                          <button
                            key={amount}
                            type="button"
                            aria-pressed={launchBudget === amount}
                            data-active={launchBudget === amount}
                            disabled={busy || stage === "complete"}
                            onClick={() => setLaunchBudget(amount)}
                          >
                            {amount}
                          </button>
                        ))}
                      </div>
                    </div>
                  </details>

                  {actionablePendingDeposit(pendingDepositBalance) > 0n && (
                    <div className="pending-deposit-card" role="status">
                      <span>
                        <b>
                          {formatUsdc(pendingDepositBalance)} USDC ready to
                          finish
                        </b>
                        <small>
                          Already on Starknet. Finish the STRK20 step—no new
                          public bridge transfer.
                        </small>
                      </span>
                      <button disabled={busy} onClick={finishPendingDeposit}>
                        Finish deposit
                      </button>
                    </div>
                  )}

                  <div className="pons-launch-cost-row">
                    <span>USDG pair, 0.0005 ETH launch fee</span>
                    <span className="pons-launch-balance-actions">
                      <button
                        type="button"
                        aria-label="Deposit"
                        title="Deposit to private balance"
                        onClick={() => setBalanceModal("deposit")}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        aria-label="Withdraw"
                        title="Withdraw private balance"
                        disabled={busy || privateBalance === 0n}
                        onClick={() => setBalanceModal("withdraw")}
                      >
                        −
                      </button>
                      <LockKeyIcon
                        size={13}
                        weight="duotone"
                        aria-hidden="true"
                      />
                    </span>
                  </div>

                  {restingPrivateBalance > 0n && (
                    <p className="summary-resting-balance">
                      {formatUsdc(restingPrivateBalance)} USDC resting · ready
                      in {formatWait(privacyWaitRemaining)}
                    </p>
                  )}

                  {error && <div className="error-banner">{error}</div>}
                  {returnResult && (
                    <div className="summary-success">
                      {formatUsdc(returnResult.amountReturned)} USDC returned
                    </div>
                  )}

                  {stage !== "complete" ? (
                    <button
                      className="pons-launch-submit"
                      type="button"
                      aria-label={
                        runtime.mode === "live" && !connectedWallet
                          ? "Connect MetaMask"
                          : runtime.mode === "live"
                            ? "MetaMask connected — Launch privately"
                            : "Launch privately"
                      }
                      disabled={
                        runtime.mode === "live" && !connectedWallet
                          ? walletConnecting || busy
                          : !launchValid || busy
                      }
                      onClick={
                        runtime.mode === "live" && !connectedWallet
                          ? connectEvmWallet
                          : launch
                      }
                    >
                      {runtime.mode === "live" && !connectedWallet
                        ? walletConnecting
                          ? "Connecting…"
                          : "Connect wallet"
                        : (busyLabel ?? "Launch privately")}
                    </button>
                  ) : (
                    <div className="summary-complete-actions">
                      {activePosition?.status === "held" && (
                        <button
                          className="button button-brand"
                          onClick={() => openSavedPosition(activePosition)}
                        >
                          Sell creator position
                        </button>
                      )}
                      {activePosition?.status === "buy-failed" &&
                        activePosition.token && (
                          <button
                            className="button button-brand"
                            onClick={() => retryPositionBuy(activePosition)}
                          >
                            Retry creator buy
                          </button>
                        )}
                      {!returnResult &&
                        activePosition &&
                        ["buy-failed", "failed", "return-failed"].includes(
                          activePosition.status,
                        ) && (
                          <button
                            className="button"
                            onClick={returnUnusedBudget}
                          >
                            Return USDC to STRK20
                          </button>
                        )}
                      <button className="button" onClick={startAnother}>
                        New position
                      </button>
                    </div>
                  )}
                </div>

                <aside className="pons-launch-preview-stage">
                  <section className="pons-launch-preview-card">
                    <span className="pons-launch-preview-image">
                      {tokenImagePreview ? (
                        <img src={tokenImagePreview} alt="" />
                      ) : (
                        <ImageIcon
                          size={22}
                          weight="duotone"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    <h2>{name || "Your token"}</h2>
                    <p>{symbol || "ticker"}</p>
                    <dl>
                      <div>
                        <dt>Launch fee</dt>
                        <dd>0.0005 ETH</dd>
                      </div>
                      <div>
                        <dt>Paired with</dt>
                        <dd className="pons-launch-usdg-value">
                          <img src={USDG_ICON_URL} alt="" /> USDG
                        </dd>
                      </div>
                      <div>
                        <dt>Trade fee</dt>
                        <dd>1.00%</dd>
                      </div>
                      <div>
                        <dt>Launch window</dt>
                        <dd>99% snipe tax, 3s</dd>
                      </div>
                      <div>
                        <dt>Graduation</dt>
                        <dd>Live curve</dd>
                      </div>
                      <div>
                        <dt>Liquidity</dt>
                        <dd>Locked</dd>
                      </div>
                      <div className="summary-row">
                        <dt className="summary-row-label">Ready balance</dt>
                        <dd className="summary-row-value">
                          <span>{formatUsdc(privateBalanceAvailable)}</span>{" "}
                          USDC
                        </dd>
                      </div>
                    </dl>
                  </section>
                </aside>
              </div>
            </section>
          )}

          {workspace === "trade" && (
            <section
              className="workspace pons-token-page"
              aria-labelledby="trade-title"
            >
              <button
                className="pons-back-button"
                type="button"
                onClick={() => switchWorkspace("explore")}
              >
                ← Back to explore
              </button>

              <section className="pons-about-strip">
                <div>
                  <span className="pons-kicker">ABOUT</span>
                  <h2>{selectedMarket.name}</h2>
                  <p>{selectedMarket.description}</p>
                </div>
                <dl>
                  <div>
                    <dt>Version</dt>
                    <dd>{selectedMarket.version}</dd>
                  </div>
                  <div>
                    <dt>Pair</dt>
                    <dd>USDG</dd>
                  </div>
                  <div>
                    <dt>Contract</dt>
                    <dd>{shorten(token)}</dd>
                  </div>
                </dl>
              </section>

              <div className="workspace-grid pons-token-layout">
                <div className="form-panel trade-card pons-buy-card">
                  <header className="pons-buy-identity">
                    <MarketArtwork market={selectedMarket} compact />
                    <span>
                      <h1 id="trade-title">{selectedMarket.name}</h1>
                      <p>
                        ${selectedMarket.symbol} · {selectedMarket.version}
                      </p>
                    </span>
                    <b>
                      <LockKeyIcon size={12} weight="fill" aria-hidden="true" />
                      Private
                    </b>
                  </header>
                  {selectedMarket.privateTrading === false && (
                    <div className="error-banner" role="status">
                      This token has graduated from the Pons bonding curve.
                      Private graduated-market trading is not supported yet, so
                      no funds will be moved.
                    </div>
                  )}
                  <div
                    className="trade-tabs"
                    role="group"
                    aria-label="Trade side"
                  >
                    <button
                      className={tradeSide === "buy" ? "active" : ""}
                      disabled={holding}
                      onClick={() => setTradeSide("buy")}
                    >
                      Buy
                    </button>
                    <button
                      className={tradeSide === "sell" ? "active" : ""}
                      disabled={!holding}
                      onClick={() => setTradeSide("sell")}
                    >
                      Sell
                    </button>
                  </div>

                  <label className="token-address-field">
                    Pons token address
                    <input
                      className="input"
                      value={token}
                      disabled={busy || holding}
                      onChange={(event) => {
                        const nextToken = event.target
                          .value as PrivateLaunchpadSession["account"];
                        setToken(nextToken);
                        const known = markets.find(
                          (market) =>
                            market.token.toLowerCase() ===
                            nextToken.toLowerCase(),
                        );
                        if (known) setSelectedMarket(known);
                      }}
                    />
                  </label>

                  <div className="swap-stack">
                    <div className="swap-box">
                      <span>
                        {tradeSide === "buy" ? "YOU PAY" : "YOU SELL"}
                      </span>
                      <div>
                        <input
                          aria-label={
                            tradeSide === "buy" ? "USDC amount" : "Token amount"
                          }
                          type="number"
                          value={
                            tradeSide === "buy"
                              ? tradeAmount
                              : activePosition?.tokenAmount
                                ? formatTokenAmount(
                                    BigInt(activePosition.tokenAmount),
                                  )
                                : 0
                          }
                          disabled={busy || tradeSide === "sell"}
                          onChange={(event) =>
                            setTradeAmount(Number(event.target.value))
                          }
                        />
                        <b>
                          {tradeSide === "buy"
                            ? "USDC"
                            : `$${activePosition?.symbol ?? "TOKEN"}`}
                        </b>
                      </div>
                      <small>
                        {tradeSide === "buy"
                          ? `Ready balance: ${formatUsdc(privateBalanceAvailable)} USDC`
                          : "Held by this onchain-separated position account"}
                      </small>
                      {tradeSide === "buy" && (
                        <button
                          className="pons-inline-deposit"
                          type="button"
                          aria-label="Deposit to STRK20 from trade"
                          onClick={() => setBalanceModal("deposit")}
                        >
                          Deposit
                        </button>
                      )}
                    </div>
                    <div className="swap-arrow">↓</div>
                    <div className="swap-box receive">
                      <span>
                        YOU RECEIVE ·{" "}
                        {lastTrade ? "EXECUTION QUOTE" : "AT EXECUTION"}
                      </span>
                      <div>
                        <strong>
                          {lastTrade
                            ? tradeSide === "buy"
                              ? formatTokenAmount(lastTrade.amountOut)
                              : formatUsdc(lastTrade.amountOut)
                            : "—"}
                        </strong>
                        <b>
                          {tradeSide === "buy"
                            ? `$${activePosition?.symbol ?? "TOKEN"}`
                            : "USDC"}
                        </b>
                      </div>
                      <small>
                        {lastTrade
                          ? `Minimum ${
                              tradeSide === "buy"
                                ? formatTokenAmount(lastTrade.minimumAmountOut)
                                : formatUsdc(lastTrade.minimumAmountOut)
                            } · Pons curve`
                          : "1% slippage · validated Pons curve"}
                      </small>
                    </div>
                  </div>

                  <dl className="trade-facts">
                    <div>
                      <dt>Account</dt>
                      <dd>
                        {activePosition
                          ? shorten(activePosition.account)
                          : identity
                            ? shorten(identity.session.account)
                            : "Fresh on execute"}
                      </dd>
                    </div>
                    <div>
                      <dt>Network</dt>
                      <dd>{runtime.network.name}</dd>
                    </div>
                    <div>
                      <dt>Execution</dt>
                      <dd>Public</dd>
                    </div>
                  </dl>

                  {error && <div className="error-banner">{error}</div>}
                  {stage !== "complete" ? (
                    <button
                      className="button button-brand action-button"
                      disabled={!tradeValid || busy}
                      onClick={trade}
                    >
                      <span>
                        {busyLabel ??
                          (selectedMarket.privateTrading === false
                            ? "Graduated trading unavailable"
                            : `${tradeSide === "buy" ? "Buy" : "Sell"} privately`)}
                      </span>
                      <b>{tradeSide === "buy" ? "↗" : "↙"}</b>
                    </button>
                  ) : (
                    <div className="complete-actions">
                      {holding ? (
                        <button
                          className="button button-brand"
                          onClick={() => {
                            setTradeSide("sell");
                            setStage("idle");
                            setTransactionHash(undefined);
                            setLastTrade(undefined);
                          }}
                        >
                          Sell this position
                        </button>
                      ) : activePosition?.status === "buy-failed" &&
                        activePosition.token ? (
                        <>
                          <button
                            className="button button-brand"
                            onClick={() => retryPositionBuy(activePosition)}
                          >
                            Retry buy
                          </button>
                          <button
                            className="button"
                            onClick={() => returnPosition(activePosition)}
                          >
                            Return USDC
                          </button>
                        </>
                      ) : activePosition?.status === "return-failed" ? (
                        <button
                          className="button button-brand"
                          onClick={() => returnPosition(activePosition)}
                        >
                          Retry private return
                        </button>
                      ) : (
                        <button
                          className="button button-brand"
                          onClick={startAnother}
                        >
                          Start another trade
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <PonsMarketChart market={selectedMarket} />
              </div>

              <section className="pons-token-lower">
                <div className="pons-activity-card">
                  <header>
                    <span>
                      <b>Activity preview</b>
                      <small>How public Pons trades will appear</small>
                    </span>
                    <span className="pons-activity-count">EXAMPLE</span>
                  </header>
                  <div className="pons-trade-list" role="list">
                    {["buy", "sell", "buy", "buy", "sell"].map(
                      (direction, index) => (
                        <div
                          className={`pons-trade-row ${direction}`}
                          role="listitem"
                          key={`${direction}-${index}`}
                        >
                          <span aria-hidden="true">
                            {direction === "buy" ? "↗" : "↙"}
                          </span>
                          <span>
                            <b>
                              {direction === "buy"
                                ? "Example private buy"
                                : "Example sell"}
                            </b>
                            <small>
                              {index === 0
                                ? "fresh account"
                                : `0x${(index + 2).toString().repeat(4)}…${(index + 7).toString().repeat(2)}`}
                            </small>
                          </span>
                          <span>
                            <b>{[25, 9.5, 50, 15, 33][index]} USDG</b>
                            <small>
                              {index === 0 ? "now" : `${index + 1}m`}
                            </small>
                          </span>
                        </div>
                      ),
                    )}
                  </div>
                </div>

                <PrivacyRoute
                  stage={stage}
                  identity={identity}
                  transactionHash={transactionHash}
                  title="Private route"
                  action={tradeSide === "buy" ? "Pons buy" : "Pons sell"}
                  funding={funding}
                  returned={returnResult}
                />
              </section>
            </section>
          )}

          {workspace === "positions" && (
            <section
              className="workspace positions portfolio-workspace"
              aria-labelledby="positions-title"
            >
              <header className="portfolio-masthead">
                <div>
                  <span className="portfolio-kicker">PRIVATE PORTFOLIO</span>
                  <h1 id="positions-title">
                    Positions held outside
                    <br />
                    <em>your root wallet.</em>
                  </h1>
                  <p>
                    Every balance below is read from its fresh Robinhood
                    account. Saved records are identified separately from live,
                    onchain proof.
                  </p>
                </div>
                <div className="portfolio-masthead-actions">
                  <span>
                    <i /> Robinhood mainnet
                  </span>
                  <div className="portfolio-masthead-buttons">
                    {runtime.recoverPositions && (
                      <button
                        type="button"
                        className="portfolio-refresh portfolio-recover"
                        disabled={
                          !connectedWallet ||
                          positionRecovery.status === "scanning"
                        }
                        onClick={() =>
                          connectedWallet &&
                          void recoverOnchainPositions(connectedWallet)
                        }
                      >
                        <MagnifyingGlassIcon size={13} aria-hidden="true" />
                        {positionRecovery.status === "scanning"
                          ? "Recovering…"
                          : "Recover onchain"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="portfolio-refresh"
                      disabled={
                        portfolioRefreshing ||
                        !connectedWallet ||
                        positions.length === 0
                      }
                      onClick={() => void refreshPortfolio()}
                    >
                      <b aria-hidden="true">↻</b>
                      {portfolioRefreshing ? "Checking chain…" : "Refresh"}
                    </button>
                  </div>
                </div>
              </header>

              {positions.length > 0 && connectedWallet ? (
                <>
                  <dl
                    className="portfolio-summary"
                    aria-label="Portfolio summary"
                  >
                    <div>
                      <dt>Live positions</dt>
                      <dd>{portfolioSummary.activePositions}</dd>
                      <small>
                        {portfolioSummary.verifiedPositions}/{positions.length}{" "}
                        accounts checked
                      </small>
                    </div>
                    <div>
                      <dt>Execution cost</dt>
                      <dd>
                        {formatUsdcPrecise(portfolioSummary.executionCost)}{" "}
                        <span>USDG</span>
                      </dd>
                      <small>Capital sent to position accounts</small>
                    </div>
                    <div>
                      <dt>Estimated exit</dt>
                      <dd>
                        {portfolioSummary.valuedPositions > 0
                          ? formatUsdcPrecise(portfolioSummary.estimatedExit)
                          : "—"}{" "}
                        <span>USDG</span>
                      </dd>
                      <small>
                        {portfolioSummary.valuedPositions > 0
                          ? `${portfolioSummary.valuedPositions} live curve quote${portfolioSummary.valuedPositions === 1 ? "" : "s"}`
                          : "Awaiting live sell quotes"}
                      </small>
                    </div>
                    <div>
                      <dt>Private balance</dt>
                      <dd>
                        {formatUsdcPrecise(privateBalanceAvailable)}{" "}
                        <span>USDG</span>
                      </dd>
                      <small>Available for another fresh account</small>
                    </div>
                  </dl>

                  <aside className="portfolio-custody-note">
                    <ShieldCheckIcon
                      size={20}
                      weight="duotone"
                      aria-hidden="true"
                    />
                    <div>
                      <b>Separated custody · wallet-authorized recovery</b>
                      <p>
                        Token balances sit in deterministic position accounts,
                        not in the connected root wallet. The app locally
                        matches your wallet-derived owners against public
                        account events, then rebuilds this map from live token
                        balances. Your signature is never uploaded or stored.
                      </p>
                    </div>
                    <span>RECOVERY READY</span>
                  </aside>

                  {positionRecovery.status !== "idle" && (
                    <p
                      className="portfolio-recovery-status"
                      data-status={positionRecovery.status}
                      role="status"
                    >
                      {positionRecovery.status === "scanning"
                        ? "Scanning Robinhood account events and matching positions locally…"
                        : positionRecovery.status === "error"
                          ? `Recovery unavailable: ${positionRecovery.message}`
                          : positionRecovery.recovered > 0
                            ? `${positionRecovery.recovered} open position${positionRecovery.recovered === 1 ? "" : "s"} recovered from Robinhood.`
                            : "Recovery complete. No open onchain positions were found."}
                    </p>
                  )}

                  <div
                    className="portfolio-grid"
                    aria-live="polite"
                    aria-busy={portfolioRefreshing}
                  >
                    {positions.map((position) => {
                      const snapshot = portfolioSnapshots[position.id];
                      const knownMarket = position.token
                        ? markets.find(
                            (market) =>
                              market.token.toLowerCase() ===
                              position.token?.toLowerCase(),
                          )
                        : undefined;
                      const artworkMarket: PonsMarket = knownMarket ?? {
                        name: position.name,
                        symbol: position.symbol,
                        token: position.token ?? demoToken,
                        description: "Saved private Pons position.",
                        marketCap: "Onchain",
                        volume: "USDG pair",
                        age: "saved",
                        version: "V2",
                        glyph: position.symbol.slice(0, 2) || "P",
                        art: "night",
                        progress: 50,
                      };
                      const tokenBalance =
                        snapshot?.tokenBalance ??
                        (position.tokenAmount
                          ? BigInt(position.tokenAmount)
                          : undefined);
                      const committed = BigInt(position.usdcCommitted);
                      const profitLoss =
                        snapshot?.estimatedUsdg !== undefined
                          ? snapshot.estimatedUsdg - committed
                          : undefined;
                      const profitLossPercent =
                        profitLoss !== undefined && committed > 0n
                          ? (Number(profitLoss) / Number(committed)) * 100
                          : undefined;
                      const executionHash =
                        position.sellTxHash ??
                        position.buyTxHash ??
                        position.launchTxHash;
                      const onchainStatus =
                        snapshot?.status === "empty"
                          ? "No token balance"
                          : snapshot?.status === "verified"
                            ? "Onchain verified"
                            : snapshot?.status === "loading"
                              ? "Checking onchain"
                              : snapshot?.status === "unavailable"
                                ? "Read unavailable"
                                : positionStatusLabel(position);

                      return (
                        <article
                          className="portfolio-position"
                          key={position.id}
                        >
                          <header className="portfolio-position-head">
                            <MarketArtwork market={artworkMarket} compact />
                            <div>
                              <span>
                                {position.kind === "trade"
                                  ? "PRIVATE BUY"
                                  : "PRIVATE LAUNCH"}
                              </span>
                              <h2>{position.name}</h2>
                              <p>
                                ${position.symbol}
                                {position.token && (
                                  <a
                                    href={`${ROBINHOOD_EXPLORER_URL}/token/${position.token}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {shorten(position.token)}
                                  </a>
                                )}
                              </p>
                            </div>
                            <span
                              className="portfolio-position-status"
                              data-status={snapshot?.status ?? position.status}
                            >
                              <i /> {onchainStatus}
                            </span>
                          </header>

                          <div className="portfolio-position-balance">
                            <span>ONCHAIN TOKEN BALANCE</span>
                            <strong>
                              {snapshot?.status === "loading" &&
                              tokenBalance === undefined
                                ? "Checking…"
                                : tokenBalance !== undefined
                                  ? formatTokenAmount(tokenBalance)
                                  : "—"}{" "}
                              <small>${position.symbol}</small>
                            </strong>
                            <p>
                              {snapshot?.status === "verified"
                                ? `Read directly at ${formatPortfolioTime(snapshot.checkedAt)}`
                                : snapshot?.status === "empty"
                                  ? `Zero balance confirmed at ${formatPortfolioTime(snapshot.checkedAt)}`
                                  : snapshot?.status === "unavailable"
                                    ? "Cached record shown; chain read failed."
                                    : "Refreshing the position account."}
                            </p>
                          </div>

                          <dl className="portfolio-position-metrics">
                            <div>
                              <dt>Sell quote</dt>
                              <dd>
                                {snapshot?.estimatedUsdg !== undefined
                                  ? formatUsdcPrecise(snapshot.estimatedUsdg)
                                  : "—"}{" "}
                                <small>USDG</small>
                              </dd>
                              <span>
                                {snapshot?.minimumUsdg !== undefined
                                  ? `${formatUsdcPrecise(snapshot.minimumUsdg)} min. after slippage`
                                  : "Live curve estimate"}
                              </span>
                            </div>
                            <div>
                              <dt>Execution cost</dt>
                              <dd>
                                {formatUsdcPrecise(committed)}{" "}
                                <small>USDG</small>
                              </dd>
                              <span>Excludes bridge overhead</span>
                            </div>
                            <div
                              className="portfolio-pnl"
                              data-direction={
                                profitLoss === undefined
                                  ? "unknown"
                                  : profitLoss >= 0n
                                    ? "up"
                                    : "down"
                              }
                            >
                              <dt>Unrealized P/L</dt>
                              <dd>
                                {profitLoss !== undefined
                                  ? formatSignedUsdc(profitLoss)
                                  : "—"}{" "}
                                <small>USDG</small>
                              </dd>
                              <span>
                                {profitLossPercent !== undefined
                                  ? `${profitLossPercent >= 0 ? "+" : ""}${profitLossPercent.toFixed(2)}%`
                                  : "Quote required"}
                              </span>
                            </div>
                          </dl>

                          <div className="portfolio-account">
                            <span className="portfolio-account-icon">
                              <VaultIcon
                                size={19}
                                weight="duotone"
                                aria-hidden="true"
                              />
                            </span>
                            <div>
                              <span>
                                POSITION ACCOUNT · R2 #{position.accountIndex}
                              </span>
                              <a
                                href={`${ROBINHOOD_EXPLORER_URL}/address/${position.account}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {position.account}
                              </a>
                            </div>
                            <small>Fresh custody account</small>
                          </div>

                          {(snapshot?.error || position.lastError) && (
                            <p
                              className="portfolio-position-warning"
                              role="status"
                            >
                              {snapshot?.error ??
                                (position.lastError
                                  ? errorMessage(new Error(position.lastError))
                                  : undefined)}
                            </p>
                          )}

                          <footer className="portfolio-position-foot">
                            <div className="portfolio-position-links">
                              {executionHash && (
                                <a
                                  href={`${ROBINHOOD_EXPLORER_URL}/tx/${executionHash}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Execution tx
                                  <ArrowRightIcon
                                    size={12}
                                    aria-hidden="true"
                                  />
                                </a>
                              )}
                              <span>
                                Saved {formatPortfolioTime(position.updatedAt)}
                              </span>
                            </div>
                            <div className="portfolio-position-actions">
                              {(tokenBalance ?? 0n) > 0n ||
                              position.status === "held" ? (
                                <button
                                  className="button button-brand"
                                  disabled={snapshot?.status === "empty"}
                                  onClick={() => openSavedPosition(position)}
                                >
                                  {snapshot?.status === "empty"
                                    ? "No balance"
                                    : "Sell position"}
                                  <ArrowRightIcon
                                    size={14}
                                    aria-hidden="true"
                                  />
                                </button>
                              ) : position.status === "buy-failed" &&
                                position.token ? (
                                <>
                                  <button
                                    className="button button-brand"
                                    onClick={() => retryPositionBuy(position)}
                                  >
                                    Retry buy
                                  </button>
                                  <button
                                    className="button"
                                    onClick={() => returnPosition(position)}
                                  >
                                    Return USDG
                                  </button>
                                </>
                              ) : position.status === "return-failed" ||
                                position.status === "returning" ? (
                                <button
                                  className="button button-brand"
                                  onClick={() => returnPosition(position)}
                                >
                                  Retry return
                                </button>
                              ) : ["launching", "buying", "selling"].includes(
                                  position.status,
                                ) ? (
                                <button
                                  className="button button-brand"
                                  onClick={() => recoverPosition(position)}
                                >
                                  Check transaction
                                </button>
                              ) : position.status === "failed" ? (
                                <button
                                  className="button button-brand"
                                  onClick={() => returnPosition(position)}
                                >
                                  Recover USDG
                                </button>
                              ) : (
                                <button
                                  className="button"
                                  onClick={() => openSavedPosition(position)}
                                >
                                  Open position
                                </button>
                              )}
                            </div>
                          </footer>
                        </article>
                      );
                    })}
                  </div>
                  <p className="portfolio-fine-print">
                    Sell quotes are indicative and can change before execution.
                    Execution cost excludes privacy-route and bridge fees; live
                    balances are authoritative for token custody. Onchain
                    recovery finds deployed accounts with open Pons balances;
                    funded accounts that never deployed still require their
                    local recovery metadata.
                  </p>
                </>
              ) : (
                <div className="portfolio-empty-shell">
                  <div className="empty-state">
                    <span className="empty-token">
                      <VaultIcon
                        size={20}
                        weight="duotone"
                        aria-hidden="true"
                      />
                    </span>
                    <div>
                      <h3>
                        {positionRecovery.status === "scanning"
                          ? "Scanning position accounts"
                          : runtime.mode === "live" && !connectedWallet
                            ? "Connect to restore positions"
                            : "No open positions found"}
                      </h3>
                      <p>
                        {positionRecovery.status === "scanning"
                          ? "Your signature stays in this browser while public Robinhood events are matched."
                          : runtime.mode === "live" && !connectedWallet
                            ? "Connect and sign once to rebuild your position list from Robinhood."
                            : positionRecovery.status === "error"
                              ? `Recovery unavailable: ${positionRecovery.message}`
                              : "No deployed account controlled by this wallet currently holds a Pons token."}
                      </p>
                    </div>
                    <button
                      className="button"
                      onClick={
                        runtime.mode === "live" && !connectedWallet
                          ? connectEvmWallet
                          : connectedWallet && runtime.recoverPositions
                            ? () =>
                                void recoverOnchainPositions(connectedWallet)
                            : () => switchWorkspace("trade")
                      }
                      disabled={positionRecovery.status === "scanning"}
                    >
                      {positionRecovery.status === "scanning"
                        ? "Recovering…"
                        : runtime.mode === "live" && !connectedWallet
                          ? "Connect MetaMask"
                          : connectedWallet && runtime.recoverPositions
                            ? "Recover onchain"
                            : "Buy a Pons token"}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
        </section>

        {workspace !== "launch" && (
          <footer className="footer">
            <span>PonsButPrivate</span>
            <nav>
              <a href="#top">Privacy model</a>
              <a href="#top">Docs</a>
              <a href="#top">Robinhood Mainnet</a>
            </nav>
            <button
              aria-label="Toggle color theme"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? (
                <SunIcon size={15} weight="duotone" aria-hidden="true" />
              ) : (
                <MoonIcon size={15} weight="duotone" aria-hidden="true" />
              )}
            </button>
          </footer>
        )}
      </main>

      {balanceModal && (
        <div className="modal-backdrop" role="presentation">
          <section
            className={`deposit-modal${balanceModal === "deposit" ? " transfer-modal" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="deposit-title"
          >
            <button
              className="modal-close"
              aria-label={`Close ${balanceModal}`}
              onClick={() => setBalanceModal(undefined)}
            >
              ×
            </button>
            <h2 id="deposit-title">
              {balanceModal === "deposit"
                ? actionablePendingDeposit(pendingDepositBalance) > 0n
                  ? "Finish STRK20 deposit"
                  : "Transfer crypto"
                : "Withdraw USDC"}
            </h2>
            <span className="modal-intro">
              {balanceModal === "deposit"
                ? actionablePendingDeposit(pendingDepositBalance) > 0n
                  ? `${formatUsdc(pendingDepositBalance)} USDC already completed the public bridge and Circle steps. Finish the final STRK20 pool step without sending or burning more USDC.`
                  : "Move any USDG amount from your connected wallet into your private STRK20 balance."
                : "The withdrawal destination, amount, and time are public. Its source inside Private Balance is not linked onchain."}
            </span>
            {balanceModal === "deposit" &&
              actionablePendingDeposit(pendingDepositBalance) === 0n && (
                <div className="transfer-configuration">
                  <div className="transfer-option">
                    <span className="transfer-asset-icon" aria-hidden="true">
                      <img src={USDG_ICON_URL} alt="" />
                    </span>
                    <span>
                      <small>Crypto</small>
                      <b>USDG</b>
                    </span>
                    <span className="transfer-option-status">Selected</span>
                  </div>
                  <div className="transfer-option">
                    <span className="transfer-chain-icon" aria-hidden="true">
                      <GlobeSimpleIcon size={17} weight="duotone" />
                    </span>
                    <span>
                      <small>Network</small>
                      <b>Robinhood Mainnet</b>
                    </span>
                    <span className="transfer-option-status">4663</span>
                  </div>
                </div>
              )}
            {balanceModal === "deposit" && (
              <div className="transfer-source-card">
                <span className="transfer-source-icon" aria-hidden="true">
                  <WalletIcon size={22} weight="duotone" />
                </span>
                <span>
                  <small>Transfer from</small>
                  <b>
                    {connectedWallet
                      ? shorten(connectedWallet)
                      : "Connect wallet"}
                  </b>
                  <em>
                    {connectedWallet
                      ? "MetaMask connected"
                      : "A Robinhood Mainnet wallet is required"}
                  </em>
                </span>
                <strong data-connected={!!connectedWallet}>
                  {connectedWallet ? "Ready" : "Required"}
                </strong>
              </div>
            )}
            <label className="transfer-amount-field">
              <span className="modal-field-label">
                <span>Amount</span>
                <small>Any amount · up to 6 decimals</small>
              </span>
              <div className="modal-amount">
                <input
                  aria-label={
                    balanceModal === "deposit"
                      ? "Deposit amount"
                      : "Withdrawal amount"
                  }
                  type="number"
                  min="0.000001"
                  step="0.000001"
                  inputMode="decimal"
                  value={depositAmount}
                  disabled={
                    busy || actionablePendingDeposit(pendingDepositBalance) > 0n
                  }
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) =>
                    setDepositAmount(Number(event.target.value))
                  }
                />
                <b>{balanceModal === "deposit" ? "USDG" : "USDC"}</b>
              </div>
            </label>
            {balanceModal === "deposit" &&
              actionablePendingDeposit(pendingDepositBalance) === 0n && (
                <>
                  <div
                    className="amount-presets modal-presets"
                    role="group"
                    aria-label="Common deposit amounts"
                  >
                    {COMMON_USDC_AMOUNTS.map((amount) => (
                      <button
                        key={amount}
                        type="button"
                        aria-pressed={depositAmount === amount}
                        data-active={depositAmount === amount}
                        disabled={busy}
                        onClick={() => setDepositAmount(amount)}
                      >
                        {amount} USDG
                      </button>
                    ))}
                  </div>
                  <p className="modal-custom-amount-note">
                    Presets are optional. You can type 13 USDG—or any other
                    supported amount—above.
                  </p>
                </>
              )}
            {balanceModal === "withdraw" && (
              <label>
                Destination
                <input
                  className="destination-input"
                  aria-label="Withdrawal destination"
                  value={withdrawDestination}
                  disabled={busy}
                  onChange={(event) =>
                    setWithdrawDestination(event.target.value)
                  }
                />
              </label>
            )}
            <div className="transfer-route-note">
              <span className="transfer-route-icon" aria-hidden="true">
                <ShieldCheckIcon size={17} weight="duotone" />
              </span>
              <span>
                <b>
                  {balanceModal === "deposit"
                    ? actionablePendingDeposit(pendingDepositBalance) > 0n
                      ? "Final private step"
                      : "Deposit route"
                    : "Public withdrawal edge"}
                </b>
                <small>
                  {balanceModal === "deposit"
                    ? actionablePendingDeposit(pendingDepositBalance) > 0n
                      ? "Starknet USDC → STRK20 pool · no new wallet transfer"
                      : "Robinhood USDG → Relay → Arbitrum USDC → STRK20"
                    : `Privacy bridge → ${shorten(withdrawDestination)} · amount and time visible`}
                </small>
              </span>
            </div>
            {balanceStep && (
              <button
                className="deposit-progress"
                type="button"
                onClick={() => setTransactionMonitorOpen(true)}
              >
                <span>Working: {balanceStep}</span>
                <b>View process →</b>
              </button>
            )}
            {error && <div className="error-banner">{error}</div>}
            <button
              className="button button-brand action-button"
              disabled={
                busy ||
                !Number.isFinite(depositAmount) ||
                depositAmount <= 0 ||
                (balanceModal === "withdraw" &&
                  usdcBaseUnits(depositAmount) > privateBalance)
              }
              onClick={
                balanceModal === "deposit"
                  ? actionablePendingDeposit(pendingDepositBalance) > 0n
                    ? finishPendingDeposit
                    : deposit
                  : withdraw
              }
            >
              <span>
                {busy
                  ? balanceModal === "deposit"
                    ? actionablePendingDeposit(pendingDepositBalance) > 0n
                      ? "Finishing deposit"
                      : "Depositing"
                    : "Withdrawing"
                  : balanceModal === "deposit"
                    ? actionablePendingDeposit(pendingDepositBalance) > 0n
                      ? "Finish deposit"
                      : runtime.mode === "demo" || connectedWallet
                        ? "Continue in wallet"
                        : "Connect wallet"
                    : "Withdraw to wallet"}
              </span>
              <ArrowRightIcon size={15} aria-hidden="true" />
            </button>
          </section>
        </div>
      )}

      {transactionMonitorOpen && (
        <aside
          className="transaction-monitor"
          role="dialog"
          aria-modal="false"
          aria-labelledby="transaction-monitor-title"
        >
          <header className="transaction-monitor-header">
            <span>
              <small>LIVE PROCESS</small>
              <h2 id="transaction-monitor-title">Transaction logger</h2>
            </span>
            <button
              type="button"
              aria-label="Close transaction logger"
              onClick={() => setTransactionMonitorOpen(false)}
            >
              ×
            </button>
          </header>

          <nav
            className="transaction-monitor-tabs"
            aria-label="Transaction log type"
          >
            <button
              type="button"
              data-active={transactionMonitorView === "execution"}
              onClick={() => setTransactionMonitorView("execution")}
            >
              Execution <span>{executionLog.length}</span>
            </button>
            <button
              type="button"
              data-active={transactionMonitorView === "deposit"}
              onClick={() => setTransactionMonitorView("deposit")}
            >
              Deposit <span>{depositLog.length}</span>
            </button>
          </nav>

          {transactionMonitorView === "execution" &&
            executionLog.length > 0 && (
              <section className="transaction-monitor-context">
                <span>ACTIVE OPERATION</span>
                <strong>{executionLog[0]?.operation}</strong>
                <small>Robinhood Mainnet · fresh account execution</small>
              </section>
            )}

          {transactionMonitorView === "deposit" && (
            <form
              className="transaction-track-form"
              onSubmit={(event) => {
                event.preventDefault();
                trackDepositTransaction(trackHashDraft);
              }}
            >
              <label htmlFor="track-transaction-hash">
                Follow a Robinhood transaction
              </label>
              <div>
                <input
                  id="track-transaction-hash"
                  value={trackHashDraft}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="0x transaction hash"
                  onChange={(event) => setTrackHashDraft(event.target.value)}
                />
                <button type="submit">Track</button>
              </div>
              {receiptCheckError && <p>{receiptCheckError}</p>}
            </form>
          )}

          {activeProcessLog.length > 0 ? (
            <ol className="transaction-timeline">
              {activeProcessLog.map((entry, index) => (
                <li key={entry.id} data-status={entry.status}>
                  <span className="transaction-timeline-index">
                    {entry.status === "done"
                      ? "✓"
                      : entry.status === "error"
                        ? "!"
                        : String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="transaction-timeline-copy">
                    <span>
                      <b>{entry.title}</b>
                      <time dateTime={new Date(entry.updatedAt).toISOString()}>
                        {new Date(entry.updatedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </time>
                    </span>
                    <p>{entry.detail}</p>
                    {entry.transactionHash && (
                      <span className="transaction-hash-row">
                        <code>{shorten(entry.transactionHash, 10, 8)}</code>
                        {entry.explorerUrl && (
                          <a
                            href={entry.explorerUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Explorer ↗
                          </a>
                        )}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="transaction-monitor-empty">
              <span>○</span>
              <p>
                {transactionMonitorView === "execution"
                  ? "Start or retry a private trade to follow funding, policy-relayer broadcast, and confirmation here."
                  : "Start a deposit or paste a transaction hash to see every public settlement and private-pool stage here."}
              </p>
            </div>
          )}

          <footer className="transaction-monitor-footer">
            <p>
              Only public transaction metadata and process states are logged.
              Private keys, signatures, notes, and viewing data never appear.
            </p>
            {activeProcessLog.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (transactionMonitorView === "execution") {
                    setExecutionLog([]);
                    localStorage.removeItem(EXECUTION_LOG_STORAGE_KEY);
                  } else {
                    setDepositLog([]);
                    setTrackedDepositHash("");
                    setTrackHashDraft("");
                    setReceiptCheckError(undefined);
                    localStorage.removeItem(DEPOSIT_LOG_STORAGE_KEY);
                    localStorage.removeItem(DEPOSIT_HASH_STORAGE_KEY);
                  }
                }}
              >
                Clear log
              </button>
            )}
          </footer>
        </aside>
      )}
    </div>
  );
}

function GraduatedArtwork({ market }: { market: GraduatedMarket }) {
  const imageSources = ponsAssetUrls(market.logo);
  const imageSourceKey = imageSources.join("\n");
  const [imageSourceIndex, setImageSourceIndex] = useState(0);
  useEffect(() => setImageSourceIndex(0), [imageSourceKey]);
  const imageSource = imageSources[imageSourceIndex];

  return (
    <span
      className={`pons-market-art${imageSource ? " has-image" : ""}`}
      aria-hidden="true"
    >
      {imageSource && (
        <img
          src={imageSource}
          alt=""
          loading="eager"
          fetchPriority="high"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImageSourceIndex((index) => index + 1)}
        />
      )}
      <span className="pons-market-badges">
        <i className="graduated">Graduated</i>
        {market.version?.toLowerCase() === "v2" && <i>V2</i>}
      </span>
      <strong>{market.name.slice(0, 1).toUpperCase()}</strong>
    </span>
  );
}

function MarketArtwork({
  market,
  compact = false,
}: {
  market: PonsMarket;
  compact?: boolean;
}) {
  const imageSourceKey = (market.imageSources ?? []).join("\n");
  const [imageSourceIndex, setImageSourceIndex] = useState(0);
  useEffect(() => setImageSourceIndex(0), [imageSourceKey]);
  const imageSource = market.imageSources?.[imageSourceIndex];
  const showImage = Boolean(imageSource);

  return (
    <span
      className={`pons-market-art pons-art-${market.art}${showImage ? " has-image" : ""}${compact ? " is-compact" : ""}`}
      aria-hidden="true"
    >
      {showImage && (
        <img
          src={imageSource}
          alt=""
          loading="eager"
          fetchPriority="high"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImageSourceIndex((index) => index + 1)}
        />
      )}
      <span className="pons-market-badges">
        <i>{market.version}</i>
        {market.live && <i className="live">Live</i>}
      </span>
      <strong>{market.glyph}</strong>
      <span className="pons-art-grid" />
    </span>
  );
}

function PonsMarketChart({ market }: { market: PonsMarket }) {
  return (
    <section
      className="pons-market-chart"
      aria-label={`${market.name} market overview`}
    >
      <dl className="pons-chart-stats">
        <div>
          <dt>Market cap</dt>
          <dd>{market.marketCap}</dd>
        </div>
        <div>
          <dt>Activity</dt>
          <dd>{market.volume}</dd>
        </div>
        <div>
          <dt>Curve progress</dt>
          <dd>{market.progress}%</dd>
        </div>
        <div>
          <dt>Venue</dt>
          <dd>Robinhood</dd>
        </div>
      </dl>

      <header className="pons-chart-head">
        <div>
          <span>Market overview</span>
          <strong>{market.marketCap}</strong>
          <small>Public curve activity · indicative preview</small>
        </div>
        <div className="pons-chart-ranges" aria-label="Chart range">
          <button>5M</button>
          <button className="active">1H</button>
          <button>6H</button>
          <button>1D</button>
          <button>ALL</button>
        </div>
      </header>

      <div className="pons-chart-stage">
        <svg
          viewBox="0 0 820 350"
          role="img"
          aria-label="Indicative market curve"
        >
          <defs>
            <linearGradient
              id={`chart-fill-${market.art}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0" stopColor="#cfff42" stopOpacity=".35" />
              <stop offset="1" stopColor="#cfff42" stopOpacity=".015" />
            </linearGradient>
          </defs>
          <g className="pons-chart-gridlines">
            <line x1="0" y1="70" x2="820" y2="70" />
            <line x1="0" y1="175" x2="820" y2="175" />
            <line x1="0" y1="280" x2="820" y2="280" />
          </g>
          <path
            className="pons-chart-area"
            fill={`url(#chart-fill-${market.art})`}
            d="M0 252 C45 240 52 110 96 144 S152 224 190 208 S235 82 272 118 S328 205 368 174 S428 92 465 132 S514 248 554 210 S618 122 655 146 S714 198 750 166 S790 110 820 126 L820 350 L0 350 Z"
          />
          <path
            className="pons-chart-line"
            d="M0 252 C45 240 52 110 96 144 S152 224 190 208 S235 82 272 118 S328 205 368 174 S428 92 465 132 S514 248 554 210 S618 122 655 146 S714 198 750 166 S790 110 820 126"
          />
          <line
            className="pons-chart-cursor"
            x1="655"
            y1="36"
            x2="655"
            y2="320"
          />
          <circle className="pons-chart-dot" cx="655" cy="146" r="5" />
        </svg>
        <span className="pons-chart-tooltip">
          <small>${market.symbol}</small>
          <b>{market.marketCap}</b>
          <i>PonsButPrivate preview</i>
        </span>
        <span className="pons-chart-axis">
          <small>12:00</small>
          <small>12:15</small>
          <small>12:30</small>
          <small>12:45</small>
        </span>
      </div>
    </section>
  );
}

function DeployDivider({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="deploy-divider">
      <span>
        {icon} {label}
      </span>
    </div>
  );
}

function AnimatedSettingRow({
  icon,
  title,
  description,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const content = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);

  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setContentHeight(element.scrollHeight);
    measure();
    if (!("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="deploy-details" data-open={open}>
      <button
        className="settings-row"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((expanded) => !expanded)}
      >
        <span className="row-icon purple">{icon}</span>
        <span>
          <b className="settings-row-title">{title}</b>
          <small className="settings-row-description">{description}</small>
        </span>
        <CaretDownIcon
          className="settings-caret"
          size={11}
          aria-hidden="true"
        />
      </button>
      <div
        className="details-collapse"
        style={{ height: open ? contentHeight : 0 }}
        aria-hidden={!open}
        inert={open ? undefined : true}
      >
        <div ref={content}>{children}</div>
      </div>
    </section>
  );
}

function AddonRow({
  icon,
  title,
  description,
  badge,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <button className="addon" type="button">
      <span className="row-icon">{icon}</span>
      <span>
        <b className="addon-title">{title}</b>
        <small className="addon-description">{description}</small>
      </span>
      {badge ? (
        <em>{badge}</em>
      ) : (
        <CaretDownIcon size={11} aria-hidden="true" />
      )}
    </button>
  );
}

function SummaryRow({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="summary-row">
      <span className="summary-row-label">{label}</span>
      <b className={accent ? "summary-row-value accent" : "summary-row-value"}>
        {value}
      </b>
    </div>
  );
}

interface PrivacyRouteProps {
  stage: OperationStage;
  identity?: PreparedIdentity | undefined;
  transactionHash?: string | undefined;
  title: string;
  action: string;
  funding?: BridgeFundResult | undefined;
  returned?: BridgeReturnResult | undefined;
}

function PrivacyRoute({
  stage,
  identity,
  transactionHash,
  title,
  action,
  funding,
  returned,
}: PrivacyRouteProps) {
  const stepState = (step: OperationStage) => {
    const order: OperationStage[] = [
      "identity",
      "funding",
      "executing",
      "returning",
      "complete",
    ];
    const current = order.indexOf(stage);
    const target = order.indexOf(step);
    if (stage === "complete") return "done";
    if (current === target) return "active";
    if (current > target) return "done";
    return "waiting";
  };

  return (
    <aside className="route-card" aria-live="polite">
      <div className="route-heading">
        <span>PRIVATE ROUTE</span>
        <i>{stage === "complete" ? "COMPLETE" : "READY"}</i>
        <h2>{title}</h2>
        <p>The EVM action is visible. The wallet behind it is not.</p>
      </div>
      <div className="route-steps">
        <RouteStep
          number="01"
          state={stepState("identity")}
          title="Fresh account"
          detail={
            identity
              ? shorten(identity.session.account, 9, 7)
              : "Derived only when needed"
          }
        />
        <RouteStep
          number="02"
          state={stepState("funding")}
          title="Private funding"
          detail={
            funding
              ? "USDC delivered from Private Balance"
              : "No root-wallet transfer to this account"
          }
        />
        <RouteStep
          number="03"
          state={stepState("executing")}
          title={action}
          detail={
            transactionHash
              ? shorten(transactionHash, 9, 7)
              : "Normal public transaction on Robinhood"
          }
        />
        <RouteStep
          number="04"
          state={stepState("returning")}
          title="Return path"
          detail={
            returned
              ? `${formatUsdc(returned.amountReturned)} USDC returned`
              : "Sell first, then return USDC privately"
          }
        />
      </div>
      <div className="truth-card">
        <div>
          <span>HIDDEN</span>
          <b>Root wallet link</b>
        </div>
        <div>
          <span>PUBLIC</span>
          <b>Token · amount · timing</b>
        </div>
      </div>
      <small className="route-footnote">
        Only recovery metadata is saved. Position keys are re-derived from your
        wallet signature; technical privacy routing is powered by STRK20.
      </small>
    </aside>
  );
}

function RouteStep({
  number,
  state,
  title,
  detail,
}: {
  number: string;
  state: "waiting" | "active" | "done";
  title: string;
  detail: string;
}) {
  return (
    <div className={`route-step ${state}`}>
      <span>{state === "done" ? "✓" : number}</span>
      <div>
        <b>{title}</b>
        <small>{detail}</small>
      </div>
      <i>{state === "active" ? "NOW" : state === "done" ? "DONE" : "WAIT"}</i>
    </div>
  );
}
