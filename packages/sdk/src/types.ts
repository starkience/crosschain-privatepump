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
}

export type RelayExecution = (request: RelayExecutionRequest) => Promise<Hash>;

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
}

export interface PrivateLaunchpadClientConfig {
  chainId: number;
  factory: Address;
  usdc: Address;
  publicClient: PublicClient;
  relay: RelayExecution;
  bridge: PrivacyBridgeEngine;
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

export interface BridgeFundResult {
  burnTxHash: string;
  accountIndex: number;
  eoaAddress: string;
  depositWallet: string;
  commitmentH: bigint;
  forwardTxHash: string;
  channel?: string;
  selection?: Record<string, unknown>;
}

export interface BridgeReturnResult {
  amountReturned: bigint;
  claimTxHash: string;
  ranFreshBurn: boolean;
  alreadyClaimed: boolean;
}

export interface PrivacyBridgeEngine {
  deriveEvmOwner(
    signature: string,
    accountIndex: number,
    channel: string,
  ): DerivedBridgeEoa;
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
