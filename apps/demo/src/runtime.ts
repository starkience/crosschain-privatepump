import {
  createPrivateLaunchpadIdentityMessage,
  type BridgeDepositResult,
  type BridgeDepositStepCallback,
  type BridgeCashOutResult,
  type BridgeCashOutStepCallback,
  type BridgeFundResult,
  type BridgeReturnResult,
  type BridgeStepCallback,
  type Eip1193Provider,
  type ClankerTradeSide,
  type ExecutionCall,
  type LaunchpadAdapter,
  type PrivateLaunchpadClient,
  type PrivateLaunchpadSession,
} from "@private-launchpad/sdk";
import { keccak256, toHex, type Hash, type Hex } from "viem";
import type { PrivatePosition } from "./positions.js";

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
  recoverPositions?(): Promise<PrivatePosition[]>;
  quoteBuy(
    account: PrivateLaunchpadSession["account"],
    draft: TradeDraft,
  ): Promise<RuntimeTradeQuote>;
  quoteSell(
    account: PrivateLaunchpadSession["account"],
    draft: TradeDraft,
  ): Promise<RuntimeTradeQuote>;
  returnToPool(onStep?: BridgeStepCallback): Promise<BridgeReturnResult>;
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
  client: PrivateLaunchpadClient;
  adapter: LaunchpadAdapter<TOpenIntent, TCloseIntent>;
  connectWallet(): Promise<PrivateLaunchpadSession["account"]>;
  signIdentity(args: {
    address: PrivateLaunchpadSession["account"];
    message: string;
  }): Promise<string>;
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
  let walletConnection: Promise<PrivateLaunchpadSession["account"]> | undefined;

  const requireIdentity = () => {
    if (!connectedAddress || !identitySignature || !session) {
      throw new Error("prepare the private identity before continuing");
    }
    return { connectedAddress, identitySignature, session };
  };

  const connect = () => {
    if (walletConnection) return walletConnection;

    const pending = config.connectWallet().then((nextAddress) => {
      if (
        connectedAddress &&
        connectedAddress.toLowerCase() !== nextAddress.toLowerCase()
      ) {
        identitySignature = undefined;
        session = undefined;
      }
      connectedAddress = nextAddress;
      return connectedAddress;
    });
    walletConnection = pending;
    pending.then(
      () => {
        if (walletConnection === pending) walletConnection = undefined;
      },
      () => {
        if (walletConnection === pending) walletConnection = undefined;
      },
    );
    return pending;
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
    async prepareIdentity(preferredAccountIndex) {
      const accountIndex =
        preferredAccountIndex ??
        (typeof config.accountIndex === "function"
          ? await config.accountIndex()
          : config.accountIndex);
      if (!Number.isSafeInteger(accountIndex) || accountIndex < 0) {
        throw new Error("account index must be a non-negative safe integer");
      }
      connectedAddress = await connect();
      identitySignature ??= await config.signIdentity({
        address: connectedAddress,
        message: createPrivateLaunchpadIdentityMessage(config.appId),
      });
      session = await config.client.deriveSession(
        identitySignature,
        accountIndex,
      );
      return {
        connectedAddress,
        storageScope: browserRecoveryScope(identitySignature),
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
      const intent = await config.trade.buildIntent(draft, identity.session);
      const quote = await config.trade.quote("buy", intent, identity.session);
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
          recoverPositions: async () => {
            const identity = requireIdentity();
            return config.recoverPositions!({
              signature: identity.identitySignature,
              connectedAddress: identity.connectedAddress,
              client: config.client,
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
    reset() {
      identitySignature = undefined;
      session = undefined;
    },
  };
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
