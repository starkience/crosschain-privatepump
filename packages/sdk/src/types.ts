import type { Address, Hash, Hex, PublicClient } from "viem";

export interface ExecutionCall {
  target: Address;
  value: bigint;
  data: Hex;
}

export interface RelayerFee {
  token: Address;
  amount: bigint;
  recipient: Address;
}

export interface PrivateLaunchpadSession {
  accountIndex: number;
  channel: string;
  owner: Address;
  account: Address;
}

export interface RelayExecutionRequest {
  chainId: number;
  factory: Address;
  account: Address;
  owner: Address;
  accountIndex: number;
  calls: readonly ExecutionCall[];
  nonce: bigint;
  deadline: bigint;
  prefund: bigint;
  fee: RelayerFee;
  signature: Hex;
  /** Relay quote whose strict deposit action this batch executes. */
  relayRequestId?: string;
  /** Server-signed binding for the exact strict Relay return quote. */
  relayQuoteAttestation?: string;
}

export type RelayExecution = (request: RelayExecutionRequest) => Promise<Hash>;

export interface ExecutionConfirmation {
  transactionHash: Hash;
  status: "success" | "reverted";
  blockNumber: bigint;
}

export interface AdapterContext {
  account: Address;
  publicClient: PublicClient;
}

export interface LaunchpadAdapter<TOpenIntent, TCloseIntent = TOpenIntent> {
  readonly id: string;
  readonly chainId: number;
  buildOpenCalls(
    intent: TOpenIntent,
    context: AdapterContext,
  ): Promise<readonly ExecutionCall[]>;
  buildCloseCalls(
    intent: TCloseIntent,
    context: AdapterContext,
  ): Promise<readonly ExecutionCall[]>;
}

export interface ExecuteOptions {
  fee?: RelayerFee;
  prefund?: bigint;
  deadlineSeconds?: number;
  /** Included for policy validation; calls remain owner-bound by EIP-712. */
  relayRequestId?: string;
  /** Included for policy validation of a strict Relay return quote. */
  relayQuoteAttestation?: string;
}

export interface PrivateLaunchpadClientConfig {
  chainId: number;
  factory: Address;
  usdc: Address;
  /** EIP-712 domain deployed by the execution-account factory. */
  executionDomainName?: string;
  publicClient: PublicClient;
  relay: RelayExecution;
  bridge: PrivacyBridgeEngine;
  /** Optional public-edge bridge route used before depositing into STRK20. */
  depositTransport?: PrivateDepositTransport;
  /** Optional cross-chain funding route used instead of the bridge's native destination. */
  fundingTransport?: SessionFundingTransport;
  /** Optional execution-chain return route used instead of native CCTP return. */
  returnTransport?: SessionReturnTransport;
  /** Optional batched return route that shares one isolated destination. */
  batchReturnTransport?: SessionBatchReturnTransport;
  channel?: string;
}

export interface DerivedBridgeEoa {
  privateKey: Hex;
  address: Address;
}

export type BridgeStepCallback = (
  step: string,
  status: "pending" | "running" | "done" | "error",
  detail?: string,
) => void;

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export type BridgeDepositStep = "deploy" | "register" | "deposit";

export type BridgeDepositStepCallback = (
  step: BridgeDepositStep,
  status: "pending" | "running" | "done" | "error",
  detail?: string,
  transactionHash?: string,
) => void;

export interface BridgeDepositResult {
  depositedNetWei: bigint;
  deposited: boolean;
}

export type BridgeCashOutStep = "burn" | "attest" | "mint";

export type BridgeCashOutStepCallback = (
  step: BridgeCashOutStep,
  status: "pending" | "running" | "done" | "error",
  detail?: string,
) => void;

export interface BridgeCashOutResult {
  burnTxHash: string;
  destination: string;
  forwardTxHash?: string;
  amountNet: bigint;
}

export interface BridgeFundResult {
  burnTxHash: string;
  accountIndex: number;
  eoaAddress: string;
  depositWallet: string;
  commitmentH: bigint;
  forwardTxHash: string;
  /** Stablecoin received on the execution chain after CCTP/bridge fees. */
  amountDelivered?: bigint;
  /** Quote-protected lower bound for the execution-chain amount. */
  minimumAmountDelivered?: bigint;
  /** Relay request used for the Arbitrum -> execution-chain leg. */
  relayRequestId?: string;
  relayStatus?: string;
  channel?: string;
  selection?: Record<string, unknown>;
}

export interface CctpForwardFeeQuote {
  maxFee: bigint;
  forwardFee: bigint;
  protocolFee: bigint;
  finalityThreshold: number;
}

export interface BridgeOutToDepositResult {
  burnTxHash: string;
  mintRecipient: Address;
  eoaAddress: Address;
  commitmentH: bigint;
}

export interface SessionFundingTransportArgs {
  bridge: PrivacyBridgeEngine;
  signature: string;
  session: PrivateLaunchpadSession;
  amount: bigint;
  connectedEvmAddress: Address;
  fast: boolean;
  onStep?: BridgeStepCallback;
}

export type SessionFundingTransport = (
  args: SessionFundingTransportArgs,
) => Promise<BridgeFundResult>;

export interface PrivateDepositTransportArgs {
  bridge: PrivacyBridgeEngine;
  signature: string;
  amount: bigint;
  provider: Eip1193Provider;
  resume: boolean;
  onStep?: BridgeDepositStepCallback;
  onBurned?: (info: { burnTxHash: string; explorerUrl?: string }) => void;
}

export type PrivateDepositTransport = (
  args: PrivateDepositTransportArgs,
) => Promise<BridgeDepositResult>;

export interface SessionReturnTransportArgs {
  bridge: PrivacyBridgeEngine;
  signature: string;
  session: PrivateLaunchpadSession;
  connectedEvmAddress: Address;
  amount: bigint;
  submitCalls(
    calls: readonly ExecutionCall[],
    context?: {
      relayRequestId?: string;
      relayQuoteAttestation?: string;
    },
  ): Promise<Hash>;
  waitForExecution(transactionHash: Hash): Promise<ExecutionConfirmation>;
  onStep?: BridgeStepCallback;
}

export type SessionReturnTransport = (
  args: SessionReturnTransportArgs,
) => Promise<BridgeReturnResult>;

export interface SessionBatchReturnSource {
  session: PrivateLaunchpadSession;
  amount: bigint;
  submitCalls(
    calls: readonly ExecutionCall[],
    context?: {
      relayRequestId?: string;
      relayQuoteAttestation?: string;
    },
  ): Promise<Hash>;
  waitForExecution(transactionHash: Hash): Promise<ExecutionConfirmation>;
}

export interface SessionBatchReturnTransportArgs {
  bridge: PrivacyBridgeEngine;
  signature: string;
  connectedEvmAddress: Address;
  sources: readonly SessionBatchReturnSource[];
  onStep?: BridgeStepCallback;
}

export type SessionBatchReturnTransport = (
  args: SessionBatchReturnTransportArgs,
) => Promise<BridgeBatchReturnResult>;

export interface BridgeReturnResult {
  amountReturned: bigint;
  claimTxHash: string;
  ranFreshBurn: boolean;
  alreadyClaimed: boolean;
}

export interface BridgeBatchReturnResult extends BridgeReturnResult {
  sourceAccountIndexes: readonly number[];
}

export interface PrivacyBridgeEngine {
  deriveEvmOwner(
    signature: string,
    accountIndex: number,
    channel: string,
  ): DerivedBridgeEoa;
  readPrivateBalance(signature: string): Promise<bigint>;
  readPendingDeposit(signature: string): Promise<bigint>;
  deriveStarknetAddress?(signature: string): string;
  /** Low-level Fast CCTP fee quote used by cross-chain funding transports. */
  quoteCctpOut?(args: {
    amount: bigint;
    destinationDomain: number;
    fast: boolean;
  }): Promise<CctpForwardFeeQuote>;
  /** Withdraw privately and have Circle forward-mint to an arbitrary strict deposit address. */
  bridgeOutToDeposit?(args: {
    signature: string;
    accountIndex: number;
    amount: bigint;
    destination: Address;
    destinationChainId: number;
    channel: string;
    fee: CctpForwardFeeQuote;
    onStatus?: (status: string) => void;
  }): Promise<BridgeOutToDepositResult>;
  sendPrivateToStarknet?(args: {
    signature: string;
    amount: bigint;
    recipient: string;
    onStatus?: (status: string) => void;
  }): Promise<{
    txHash: string;
    recipient: string;
    amount: bigint;
    confirmed: boolean;
  }>;
  moveIntoPool(args: {
    signature: Hex;
    funding: "metamask";
    amountWei: bigint;
    provider: Eip1193Provider;
    sourceChainId?: number;
    resume?: boolean;
    onStep?: BridgeDepositStepCallback;
    onBurned?: (info: { burnTxHash: string; explorerUrl?: string }) => void;
  }): Promise<BridgeDepositResult>;
  cashOut(args: {
    resolveSignature: () => Promise<string>;
    amount: bigint;
    destination: string;
    evmAddress: string;
    destChainId?: number;
    onStep?: BridgeCashOutStepCallback;
  }): Promise<BridgeCashOutResult>;
  fundAccountFromPool(args: {
    resolveSignature: () => Promise<string>;
    accountIndex: number;
    amount: bigint;
    evmAddress: string;
    resolveDepositWallet: (
      signature: string,
      accountIndex: number,
      channel?: string,
    ) => Promise<string>;
    destChainId: number;
    channel: string;
    fast?: boolean;
    onStep?: BridgeStepCallback;
  }): Promise<BridgeFundResult>;
  returnToPool(args: {
    signature: string;
    accountIndex: number;
    channel: string;
    evmAddress: string;
    destChainId: number;
    readReturnableBalance: () => Promise<bigint>;
    prepareFreshReturn: () => Promise<{
      amount: bigint;
      depositWallet: string;
      submitGaslessBatch: (
        calls: Array<{ target: string; data: Hex }>,
      ) => Promise<string>;
    }>;
    onStep?: BridgeStepCallback;
  }): Promise<BridgeReturnResult>;
}

export const NO_RELAYER_FEE: RelayerFee = {
  token: "0x0000000000000000000000000000000000000000",
  amount: 0n,
  recipient: "0x0000000000000000000000000000000000000000",
};
