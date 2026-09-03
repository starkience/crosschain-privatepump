import {
  createPrivateLaunchpadIdentityMessage,
  type BridgeDepositResult,
  type BridgeDepositStepCallback,
  type BridgeCashOutResult,
  type BridgeCashOutStepCallback,
  type BridgeFundResult,
  type BridgeBatchReturnResult,
  type BridgeReturnResult,
  type BridgeStepCallback,
  type Eip1193Provider,
  type ClankerTradeSide,
  type ExecutionCall,
  type LaunchpadAdapter,
  type PrivateLaunchpadClient,
  type PrivateLaunchpadSession,
  type WalletBatchReturnResult,
} from "@private-launchpad/sdk";
import { keccak256, toHex, type Hash, type Hex } from "viem";
import type { PrivatePosition } from "./positions.js";

const DEFAULT_WALLET_REQUEST_TIMEOUT_MS = 60_000;

export interface LaunchDraft {
  name: string;
  symbol: string;
  description?: string;
  bridgeAmount: bigint;
  creatorReward: number;
  /** Stable per-launch salt so the token address can be predicted safely. */
  salt: Hex;
}

export interface TradeDraft {
  token: PrivateLaunchpadSession["account"];
  amountIn: bigint;
  slippageBps: number;
}

export interface PreparedIdentity {
  connectedAddress: PrivateLaunchpadSession["account"];
  /** Secret-derived opaque namespace for non-secret browser recovery data. */
  storageScope: Hex;
  session: PrivateLaunchpadSession;
}

export interface TransactionConfirmation {
  status: "success" | "reverted";
  blockNumber: bigint;
}

export interface LaunchExecution {
  transactionHash: string;
  token: PrivateLaunchpadSession["account"];
}

export interface TradeExecution {
  transactionHash: string;
  amountIn: bigint;
  amountOut: bigint;
  minimumAmountOut: bigint;
}

/** A trade failed before the policy relayer could receive a transaction. */
export class ExecutionNotBroadcastError extends Error {
  readonly broadcasted = false;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ExecutionNotBroadcastError";
  }
}

export interface DepositTransactionInfo {
  burnTxHash: string;
  explorerUrl?: string;
}

export interface RuntimeTradeQuote {
  amountIn: bigint;
  amountOut: bigint;
  minimumAmountOut: bigint;
  calls: readonly ExecutionCall[];
}

export interface MarketMetadata {
  name: string;
  symbol: string;
  logo?: string;
  description?: string;
}

export interface LaunchpadRuntime {
  readonly mode: "demo" | "live";
  readonly network: { name: string; chainId: number };
  connectWallet(): Promise<PrivateLaunchpadSession["account"]>;
  /** Optional connector that bypasses an unresponsive injected extension. */
  connectWalletFallback?(): Promise<PrivateLaunchpadSession["account"]>;
  prepareIdentity(accountIndex?: number): Promise<PreparedIdentity>;
  readPrivateBalance(): Promise<bigint>;
  readPendingDeposit(): Promise<bigint>;
  deposit(
    amount: bigint,
    onStep?: BridgeDepositStepCallback,
    onSubmitted?: (info: DepositTransactionInfo) => void,
  ): Promise<BridgeDepositResult>;
  resumeDeposit(
    amount: bigint,
    onStep?: BridgeDepositStepCallback,
  ): Promise<BridgeDepositResult>;
  withdraw(
    amount: bigint,
    destination: PrivateLaunchpadSession["account"],
    onStep?: BridgeCashOutStepCallback,
  ): Promise<BridgeCashOutResult>;
  fund(
    draft: LaunchDraft,
    onStep?: BridgeStepCallback,
  ): Promise<BridgeFundResult>;
  launch(draft: LaunchDraft): Promise<LaunchExecution>;
  waitForTransaction(transactionHash: string): Promise<TransactionConfirmation>;
  buy(draft: TradeDraft): Promise<TradeExecution>;
  sell(draft: TradeDraft): Promise<TradeExecution>;
  readTokenBalance(token: TradeDraft["token"]): Promise<bigint>;
  readAccountTokenBalance(
    account: PrivateLaunchpadSession["account"],
    token: TradeDraft["token"],
  ): Promise<bigint>;
  readMarketMetadata?(token: TradeDraft["token"]): Promise<MarketMetadata>;
  recoverPositions?(signal?: AbortSignal): Promise<PrivatePosition[]>;
  quoteBuy(
    account: PrivateLaunchpadSession["account"],
    draft: TradeDraft,
  ): Promise<RuntimeTradeQuote>;
  quoteSell(
    account: PrivateLaunchpadSession["account"],
    draft: TradeDraft,
  ): Promise<RuntimeTradeQuote>;
  returnToPool(onStep?: BridgeStepCallback): Promise<BridgeReturnResult>;
  returnMultipleToPool(
    accountIndexes: readonly number[],
    onStep?: BridgeStepCallback,
  ): Promise<BridgeBatchReturnResult>;
  returnMultipleToWallet(
    accountIndexes: readonly number[],
    onStep?: BridgeStepCallback,
  ): Promise<WalletBatchReturnResult>;
  reset(): void;
}

export interface LiveRuntimeConfig<
  TOpenIntent,
  TCloseIntent,
  TTradeIntent = never,
> {
  appId: string;
  networkName?: string;
  accountIndex: number | (() => Promise<number> | number);
  /** Use CCTP soft-finality attestations for Starknet-to-EVM funding. */
  fastFunding?: boolean;
  /** Fail closed before private funds move when execution cannot be relayed. */
  preflightFunding?(): Promise<void>;
  client: PrivateLaunchpadClient;
  adapter: LaunchpadAdapter<TOpenIntent, TCloseIntent>;
  connectWallet(): Promise<PrivateLaunchpadSession["account"]>;
  connectWalletFallback?(): Promise<PrivateLaunchpadSession["account"]>;
  signIdentity(args: {
    address: PrivateLaunchpadSession["account"];
    message: string;
  }): Promise<string>;
  /** Bounds injected-wallet requests so the UI cannot remain pending forever. */
  walletRequestTimeoutMs?: number;
  buildOpenIntent(
    draft: LaunchDraft,
    session: PrivateLaunchpadSession,
  ): Promise<TOpenIntent> | TOpenIntent;
  resolveOpenToken?(
    intent: TOpenIntent,
    session: PrivateLaunchpadSession,
  ): Promise<PrivateLaunchpadSession["account"]>;
  resolveOpenTokenAfterExecution?(
    transactionHash: Hash,
    intent: TOpenIntent,
    session: PrivateLaunchpadSession,
  ): Promise<PrivateLaunchpadSession["account"]>;
  openOptions?(
    intent: TOpenIntent,
    session: PrivateLaunchpadSession,
  ): Promise<import("@private-launchpad/sdk").ExecuteOptions>;
  depositProvider?(): Promise<Eip1193Provider> | Eip1193Provider;
  readMarketMetadata?(token: TradeDraft["token"]): Promise<MarketMetadata>;
  recoverPositions?(args: {
    signature: string;
    connectedAddress: PrivateLaunchpadSession["account"];
    client: PrivateLaunchpadClient;
    signal?: AbortSignal;
  }): Promise<PrivatePosition[]>;
  trade?: {
    quote(
      side: ClankerTradeSide,
      intent: TTradeIntent,
      session: PrivateLaunchpadSession,
    ): Promise<RuntimeTradeQuote>;
    buildIntent(
      draft: TradeDraft,
      session: PrivateLaunchpadSession,
    ): Promise<TTradeIntent> | TTradeIntent;
  };
}

/**
 * Production binding for a host application. Identity material is retained only
 * inside this closure and is never returned to React state, storage, or logs.
 */
export function createLiveRuntime<
  TOpenIntent,
  TCloseIntent,
  TTradeIntent = never,
>(
  config: LiveRuntimeConfig<TOpenIntent, TCloseIntent, TTradeIntent>,
): LaunchpadRuntime {
  let connectedAddress: PrivateLaunchpadSession["account"] | undefined;
  let identitySignature: string | undefined;
  let session: PrivateLaunchpadSession | undefined;
  let walletConnectionRequest:
    Promise<PrivateLaunchpadSession["account"]> | undefined;
  let walletConnectionGeneration = 0;
  let identitySignatureRequest: Promise<string> | undefined;
  let identitySignatureRequestAddress:
    PrivateLaunchpadSession["account"] | undefined;
  const walletRequestTimeoutMs =
    config.walletRequestTimeoutMs ?? DEFAULT_WALLET_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(walletRequestTimeoutMs) ||
    walletRequestTimeoutMs <= 0
  ) {
    throw new Error("wallet request timeout must be a positive safe integer");
  }

  const requireIdentity = () => {
    if (!connectedAddress || !identitySignature || !session) {
      throw new Error("prepare the private identity before continuing");
    }
    return { connectedAddress, identitySignature, session };
  };

  const adoptConnectedAddress = (
    nextAddress: PrivateLaunchpadSession["account"],
  ) => {
    if (
      connectedAddress &&
      connectedAddress.toLowerCase() !== nextAddress.toLowerCase()
    ) {
      identitySignature = undefined;
      session = undefined;
    }
    connectedAddress = nextAddress;
    return connectedAddress;
  };

  const connect = () => {
    if (connectedAddress) return Promise.resolve(connectedAddress);

    if (!walletConnectionRequest) {
      const requestGeneration = walletConnectionGeneration;
      const rawRequest = Promise.resolve()
        .then(() => config.connectWallet())
        .then((nextAddress) => {
          if (requestGeneration !== walletConnectionGeneration) {
            return connectedAddress ?? nextAddress;
          }
          return adoptConnectedAddress(nextAddress);
        });
      walletConnectionRequest = rawRequest;
      rawRequest.then(
        () => {
          if (walletConnectionRequest === rawRequest) {
            walletConnectionRequest = undefined;
          }
        },
        () => {
          if (walletConnectionRequest === rawRequest) {
            walletConnectionRequest = undefined;
          }
        },
      );
    }

    return walletRequestWithTimeout(
      walletConnectionRequest,
      walletRequestTimeoutMs,
      "MetaMask did not respond. Its provider request is still pending, so retrying will not create another request. Open MetaMask and resolve it; if the extension stream is unresponsive, restart Chrome and unlock MetaMask.",
    );
  };

  const signPrivateIdentity = (
    activeAddress: PrivateLaunchpadSession["account"],
  ): Promise<string> => {
    if (identitySignature) return Promise.resolve(identitySignature);
    if (
      identitySignatureRequest &&
      identitySignatureRequestAddress?.toLowerCase() !==
        activeAddress.toLowerCase()
    ) {
      return Promise.reject(
        new Error(
          "A MetaMask sign-in request is pending for another account. Resolve it in MetaMask or reload after switching accounts.",
        ),
      );
    }

    if (!identitySignatureRequest) {
      const requestGeneration = walletConnectionGeneration;
      const rawRequest = Promise.resolve().then(() =>
        config.signIdentity({
          address: activeAddress,
          message: createPrivateLaunchpadIdentityMessage(config.appId),
        }),
      );
      identitySignatureRequest = rawRequest;
      identitySignatureRequestAddress = activeAddress;
      rawRequest.then(
        (signature) => {
          if (
            requestGeneration === walletConnectionGeneration &&
            connectedAddress?.toLowerCase() === activeAddress.toLowerCase()
          ) {
            identitySignature = signature;
          }
          if (identitySignatureRequest === rawRequest) {
            identitySignatureRequest = undefined;
            identitySignatureRequestAddress = undefined;
          }
        },
        () => {
          if (identitySignatureRequest === rawRequest) {
            identitySignatureRequest = undefined;
            identitySignatureRequestAddress = undefined;
          }
        },
      );
    }

    return walletRequestWithTimeout(
      identitySignatureRequest,
      walletRequestTimeoutMs,
      "A MetaMask sign-in request is still pending. Open MetaMask and approve or reject that request; if its provider stream is unresponsive, restart Chrome and unlock MetaMask. Retrying will not stack another request.",
    );
  };

  return {
    mode: "live",
    network: {
      name:
        config.networkName ??
        (config.adapter.chainId === 84532 ? "Base Sepolia" : "Base"),
      chainId: config.adapter.chainId,
    },
    connectWallet: connect,
    ...(config.connectWalletFallback
      ? {
          async connectWalletFallback() {
            // Invalidate any injected-provider request that never settled. The
            // browser has no cancellation API for it, but its late result must
            // not replace the deliberately selected fallback provider.
            walletConnectionGeneration += 1;
            walletConnectionRequest = undefined;
            identitySignatureRequest = undefined;
            identitySignatureRequestAddress = undefined;
            const nextAddress = await config.connectWalletFallback!();
            return adoptConnectedAddress(nextAddress);
          },
        }
      : {}),
    async prepareIdentity(preferredAccountIndex) {
      const prepareGeneration = walletConnectionGeneration;
      const accountIndex =
        preferredAccountIndex ??
        (typeof config.accountIndex === "function"
          ? await config.accountIndex()
          : config.accountIndex);
      if (!Number.isSafeInteger(accountIndex) || accountIndex < 0) {
        throw new Error("account index must be a non-negative safe integer");
      }
      const activeAddress = await connect();
      connectedAddress = activeAddress;
      let activeIdentitySignature = identitySignature;
      if (!activeIdentitySignature) {
        activeIdentitySignature = await signPrivateIdentity(activeAddress);
      }
      if (prepareGeneration !== walletConnectionGeneration) {
        throw new Error(
          "The wallet connection was replaced by another request",
        );
      }
      identitySignature = activeIdentitySignature;
      const nextSession = await config.client.deriveSession(
        activeIdentitySignature,
        accountIndex,
      );
      if (prepareGeneration !== walletConnectionGeneration) {
        throw new Error(
          "The wallet connection was replaced by another request",
        );
      }
      session = nextSession;
      return {
        connectedAddress: activeAddress,
        storageScope: browserRecoveryScope(activeIdentitySignature),
        session,
      };
    },
    async readPrivateBalance() {
      return config.client.readPrivateBalance(
        requireIdentity().identitySignature,
      );
    },
    async readPendingDeposit() {
      return config.client.readPendingDeposit(
        requireIdentity().identitySignature,
      );
    },
    async deposit(amount, onStep, onSubmitted) {
      const identity = requireIdentity();
      if (!config.depositProvider) {
        throw new Error("EVM deposit provider is not configured");
      }
      const provider = await config.depositProvider();
      return config.client.depositToPrivateBalance({
        signature: identity.identitySignature,
        amount,
        provider,
        ...(onStep ? { onStep } : {}),
        ...(onSubmitted ? { onBurned: onSubmitted } : {}),
      });
    },
    async resumeDeposit(amount, onStep) {
      const identity = requireIdentity();
      if (!config.depositProvider) {
        throw new Error("EVM deposit provider is not configured");
      }
      const provider = await config.depositProvider();
      return config.client.depositToPrivateBalance({
        signature: identity.identitySignature,
        amount,
        provider,
        resume: true,
        ...(onStep ? { onStep } : {}),
      });
    },
    async withdraw(amount, destination, onStep) {
      const identity = requireIdentity();
      return config.client.withdrawPrivateBalance({
        signature: identity.identitySignature,
        amount,
        destination,
        connectedEvmAddress: identity.connectedAddress,
        ...(onStep ? { onStep } : {}),
      });
    },
    async fund(draft, onStep) {
      const identity = requireIdentity();
      if (draft.bridgeAmount <= 0n) {
        throw new Error("STRK20 launch funding must be greater than zero");
      }
      await config.preflightFunding?.();
      const result = await config.client.fundSession({
        signature: identity.identitySignature,
        accountIndex: identity.session.accountIndex,
        amount: draft.bridgeAmount,
        connectedEvmAddress: identity.connectedAddress,
        fast: config.fastFunding ?? true,
        ...(onStep ? { onStep } : {}),
      });
      if (result.accountIndex !== identity.session.accountIndex) {
        session = await config.client.deriveSession(
          identity.identitySignature,
          result.accountIndex,
        );
      }
      return result;
    },
    async launch(draft) {
      const identity = requireIdentity();
      if (draft.bridgeAmount <= 0n) {
        throw new Error("STRK20 launch funding must be greater than zero");
      }
      const intent = await config.buildOpenIntent(draft, identity.session);
      let token = config.resolveOpenToken
        ? await config.resolveOpenToken(intent, identity.session)
        : identity.session.account;
      const options = config.openOptions
        ? await config.openOptions(intent, identity.session)
        : undefined;
      const transactionHash = await config.client.open({
        signature: identity.identitySignature,
        session: identity.session,
        adapter: config.adapter,
        intent,
        ...(options ? { options } : {}),
      });
      if (config.resolveOpenTokenAfterExecution) {
        token = await config.resolveOpenTokenAfterExecution(
          transactionHash,
          intent,
          identity.session,
        );
      }
      return { transactionHash, token };
    },
    async waitForTransaction(transactionHash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
        throw new Error("cannot confirm an invalid transaction hash");
      }
      const confirmation = await config.client.waitForExecution(
        transactionHash as `0x${string}`,
      );
      return {
        status: confirmation.status,
        blockNumber: confirmation.blockNumber,
      };
    },
    async buy(draft) {
      const identity = requireIdentity();
      if (!config.trade) throw new Error("launchpad trading is not configured");
      let intent: TTradeIntent;
      let quote: RuntimeTradeQuote;
      try {
        intent = await config.trade.buildIntent(draft, identity.session);
        quote = await config.trade.quote("buy", intent, identity.session);
      } catch (error) {
        throw new ExecutionNotBroadcastError(error);
      }
      const transactionHash = await config.client.execute(
        identity.identitySignature,
        identity.session,
        quote.calls,
      );
      return {
        transactionHash,
        amountIn: quote.amountIn,
        amountOut: quote.amountOut,
        minimumAmountOut: quote.minimumAmountOut,
      };
    },
    async sell(draft) {
      const identity = requireIdentity();
      if (!config.trade) throw new Error("launchpad trading is not configured");
      const intent = await config.trade.buildIntent(draft, identity.session);
      const quote = await config.trade.quote("sell", intent, identity.session);
      const transactionHash = await config.client.execute(
        identity.identitySignature,
        identity.session,
        quote.calls,
      );
      return {
        transactionHash,
        amountIn: quote.amountIn,
        amountOut: quote.amountOut,
        minimumAmountOut: quote.minimumAmountOut,
      };
    },
    async readTokenBalance(token) {
      return config.client.readSessionTokenBalance(
        requireIdentity().session,
        token,
      );
    },
    async readAccountTokenBalance(account, token) {
      return config.client.readAccountTokenBalance(account, token);
    },
    ...(config.readMarketMetadata
      ? {
          readMarketMetadata: (token: TradeDraft["token"]) =>
            config.readMarketMetadata!(token),
        }
      : {}),
    ...(config.recoverPositions
      ? {
          recoverPositions: async (signal?: AbortSignal) => {
            const identity = requireIdentity();
            return config.recoverPositions!({
              signature: identity.identitySignature,
              connectedAddress: identity.connectedAddress,
              client: config.client,
              ...(signal ? { signal } : {}),
            });
          },
        }
      : {}),
    async quoteBuy(account, draft) {
      if (!config.trade) throw new Error("launchpad trading is not configured");
      // Quotes are read-only. They need the position account as msg.sender for
      // call construction, but they do not need funded account state or secrets.
      const quoteSession: PrivateLaunchpadSession = {
        accountIndex: session?.accountIndex ?? 0,
        channel: session?.channel ?? config.client.channel,
        owner: session?.owner ?? account,
        account,
      };
      const intent = await config.trade.buildIntent(draft, quoteSession);
      return config.trade.quote("buy", intent, quoteSession);
    },
    async quoteSell(account, draft) {
      if (!config.trade) throw new Error("launchpad trading is not configured");
      // Quotes are read-only. They need the position account as msg.sender for
      // allowance/call construction, but they do not need identity secrets.
      const quoteSession: PrivateLaunchpadSession = {
        accountIndex: session?.accountIndex ?? 0,
        channel: session?.channel ?? config.client.channel,
        owner: session?.owner ?? account,
        account,
      };
      const intent = await config.trade.buildIntent(draft, quoteSession);
      return config.trade.quote("sell", intent, quoteSession);
    },
    async returnToPool(onStep) {
      const identity = requireIdentity();
      return config.client.returnSession({
        signature: identity.identitySignature,
        session: identity.session,
        connectedEvmAddress: identity.connectedAddress,
        ...(onStep ? { onStep } : {}),
      });
    },
    async returnMultipleToPool(accountIndexes, onStep) {
      const identity = requireIdentity();
      return config.client.returnSessions({
        signature: identity.identitySignature,
        accountIndexes,
        connectedEvmAddress: identity.connectedAddress,
        ...(onStep ? { onStep } : {}),
      });
    },
    async returnMultipleToWallet(accountIndexes, onStep) {
      const identity = requireIdentity();
      return config.client.returnSessionsToWallet({
        signature: identity.identitySignature,
        accountIndexes,
        connectedEvmAddress: identity.connectedAddress,
        authorize: (message) =>
          walletRequestWithTimeout(
            Promise.resolve().then(() =>
              config.signIdentity({
                address: identity.connectedAddress,
                message,
              }),
            ),
            walletRequestTimeoutMs,
            "MetaMask did not respond to the recovery authorization. Close any stale wallet popup and retry.",
          ),
        ...(onStep ? { onStep } : {}),
      });
    },
    reset() {
      identitySignature = undefined;
      session = undefined;
    },
  };
}

function walletRequestWithTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(
      () => reject(new Error(message)),
      timeoutMs,
    );
    request.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

const demoAccount =
  "0x8A4dC8408fB8637A3fD0C0ba8ce95C18B38b5A02" as PrivateLaunchpadSession["account"];
const demoOwner =
  "0x46a8f65f337D2511690A54281017E21b03B0Ab47" as PrivateLaunchpadSession["owner"];
const demoRoot =
  "0x7C26A0F7B7e9DfAA0D21e19b9E5D1D1D8bA84491" as PrivateLaunchpadSession["account"];

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));

async function demoSteps(
  steps: readonly string[],
  onStep?: BridgeStepCallback,
): Promise<void> {
  for (const step of steps) {
    onStep?.(step, "running");
    await pause(420);
    onStep?.(step, "done");
  }
}

export function createDemoRuntime(): LaunchpadRuntime {
  let prepared = false;
  return {
    mode: "demo",
    network: { name: "Base", chainId: 8453 },
    async connectWallet() {
      await pause(220);
      return demoRoot;
    },
    async prepareIdentity(accountIndex = 7) {
      await pause(520);
      prepared = true;
      return {
        connectedAddress: demoRoot,
        storageScope: `0x${"99".repeat(32)}`,
        session: {
          accountIndex,
          channel: "private-launchpad-v1",
          owner: demoOwner,
          account: demoAccount,
        },
      };
    },
    async readPrivateBalance() {
      if (!prepared) throw new Error("demo identity is not prepared");
      return 250_000_000n;
    },
    async readPendingDeposit() {
      if (!prepared) throw new Error("demo identity is not prepared");
      return 0n;
    },
    async deposit(amount, onStep) {
      if (!prepared) throw new Error("demo identity is not prepared");
      for (const step of ["deploy", "register", "deposit"] as const) {
        onStep?.(step, "running");
        await pause(360);
        onStep?.(step, "done");
      }
      return { depositedNetWei: amount, deposited: true };
    },
    async resumeDeposit(amount, onStep) {
      if (!prepared) throw new Error("demo identity is not prepared");
      for (const step of ["register", "deposit"] as const) {
        onStep?.(step, "running");
        await pause(360);
        onStep?.(step, "done");
      }
      return { depositedNetWei: amount, deposited: true };
    },
    async withdraw(amount, destination, onStep) {
      if (!prepared) throw new Error("demo identity is not prepared");
      for (const step of ["burn", "attest", "mint"] as const) {
        onStep?.(step, "running");
        await pause(360);
        onStep?.(step, "done");
      }
      return {
        burnTxHash: sampleHash("cash-out-burn"),
        destination,
        forwardTxHash: sampleHash("cash-out-forward"),
        amountNet: amount,
      };
    },
    async fund(draft, onStep) {
      if (!prepared) throw new Error("demo identity is not prepared");
      if (draft.bridgeAmount <= 0n) {
        throw new Error("STRK20 launch funding must be greater than zero");
      }
      await demoSteps(
        ["select-private-note", "circle-burn", "base-mint"],
        onStep,
      );
      return {
        burnTxHash: sampleHash("burn"),
        accountIndex: 7,
        eoaAddress: demoOwner,
        depositWallet: demoAccount,
        commitmentH: 170141183460469231731687303715884105727n,
        forwardTxHash: sampleHash("forward"),
        channel: "private-launchpad-v1",
      };
    },
    async launch(draft) {
      if (!prepared) throw new Error("demo identity is not prepared");
      if (draft.bridgeAmount <= 0n) {
        throw new Error("STRK20 launch funding must be greater than zero");
      }
      await pause(920);
      return {
        transactionHash: sampleHash(`${draft.symbol}-launch`),
        token: demoTokenAddress(draft.salt),
      };
    },
    async waitForTransaction() {
      await pause(640);
      return { status: "success", blockNumber: 31_415_926n };
    },
    async buy(draft) {
      if (!prepared) throw new Error("demo identity is not prepared");
      await pause(820);
      return {
        transactionHash: sampleHash(`${draft.token}-${draft.amountIn}-buy`),
        amountIn: draft.amountIn,
        amountOut: 1_240_000n * 10n ** 18n,
        minimumAmountOut: 1_227_600n * 10n ** 18n,
      };
    },
    async sell(draft) {
      if (!prepared) throw new Error("demo identity is not prepared");
      await pause(820);
      return {
        transactionHash: sampleHash(`${draft.token}-${draft.amountIn}-sell`),
        amountIn: draft.amountIn,
        amountOut: 24_200_000n,
        minimumAmountOut: 23_958_000n,
      };
    },
    async readTokenBalance() {
      if (!prepared) throw new Error("demo identity is not prepared");
      return 1_240_000n * 10n ** 18n;
    },
    async readAccountTokenBalance() {
      if (!prepared) throw new Error("demo identity is not prepared");
      return 1_240_000n * 10n ** 18n;
    },
    async quoteBuy(_account, draft) {
      if (!prepared) throw new Error("demo identity is not prepared");
      return {
        amountIn: draft.amountIn,
        amountOut: 1_240_000n * 10n ** 18n,
        minimumAmountOut: 1_227_600n * 10n ** 18n,
        calls: [],
      };
    },
    async quoteSell(_account, draft) {
      if (!prepared) throw new Error("demo identity is not prepared");
      return {
        amountIn: draft.amountIn,
        amountOut: 24_200_000n,
        minimumAmountOut: 23_958_000n,
        calls: [],
      };
    },
    async returnToPool(onStep) {
      if (!prepared) throw new Error("demo identity is not prepared");
      await demoSteps(
        ["base-burn", "circle-attestation", "mint-private-note"],
        onStep,
      );
      return {
        amountReturned: 24_200_000n,
        claimTxHash: sampleHash("claim"),
        ranFreshBurn: true,
        alreadyClaimed: false,
      };
    },
    async returnMultipleToPool(accountIndexes, onStep) {
      if (!prepared) throw new Error("demo identity is not prepared");
      await demoSteps(["relay-return", "s2-deposit", "private-merge"], onStep);
      return {
        amountReturned: 24_200_000n,
        claimTxHash: sampleHash("batch-claim"),
        ranFreshBurn: true,
        alreadyClaimed: false,
        sourceAccountIndexes: accountIndexes,
      };
    },
    async returnMultipleToWallet(accountIndexes, onStep) {
      if (!prepared) throw new Error("demo identity is not prepared");
      await demoSteps(["wallet-return"], onStep);
      return {
        amountReturned: 24_200_000n,
        recipient: demoRoot,
        sourceAccountIndexes: accountIndexes,
        transactionHashes: [sampleHash("wallet-return")],
      };
    },
    reset() {
      prepared = false;
    },
  };
}

function browserRecoveryScope(identitySignature: string): Hex {
  return keccak256(
    toHex(`private-launchpad.browser-recovery.v2:${identitySignature}`),
  );
}

function demoTokenAddress(salt: Hex): PrivateLaunchpadSession["account"] {
  return `0x${salt.slice(2, 42)}` as PrivateLaunchpadSession["account"];
}

function sampleHash(seed: string): `0x${string}` {
  let value = 2166136261;
  for (const character of seed) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  const word = (value >>> 0).toString(16).padStart(8, "0");
  return `0x${word.repeat(8)}`;
}
