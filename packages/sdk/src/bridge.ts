import { getAddress, isAddress, type Hex } from "viem";
import type { PrivacyBridgeEngine } from "./types.js";

export interface StarkwarePrivacyBridgeExports {
  deriveStarknetPrivateKey(signature: string): string;
  deriveStarknetAccount(
    privateKey: string,
    classHash: string,
  ): { address: string };
  deriveViewingKey(signature: string): bigint;
  deriveAccountNonce(
    viewingKey: bigint,
    accountIndex: number,
    channel?: string,
  ): bigint;
  discoverPrivateBalanceForAddress(args: {
    snAddress: string;
    viewingKey: bigint;
  }): Promise<bigint>;
  readUndepositedResidual(snAddress: string): Promise<bigint>;
  getActiveConfig(): { ozClassHash: string };
  derivePolygonEoa(
    signature: string,
    accountIndex: number,
    channel?: string,
  ): { privateKey: string; address: string };
  fetchForwardMaxFee(
    amount: bigint,
    options: { fast: boolean; destDomain: number },
  ): Promise<{
    maxFee: bigint;
    forwardFee: bigint;
    protocolFee: bigint;
    finalityThreshold: number;
  }>;
  bridgeOut(args: {
    signature: string;
    accountIndex: number;
    accountNonce: bigint;
    amount: bigint;
    channel?: string;
    minFinalityThreshold: number;
    quotedFinalityThreshold: number;
    maxFee: bigint;
    destChainId: number;
    resolveDepositWallet: () => Promise<string>;
    onStatus?: (status: string) => void;
  }): Promise<{
    burnTxHash: string;
    mintRecipient: string;
    eoaAddress: string;
    commitmentH: bigint;
  }>;
  sendPrivateToStarknet(args: {
    resolveSignature: () => Promise<string>;
    amount: bigint;
    recipient: string;
    onStatus?: (status: string) => void;
  }): Promise<{
    txHash: string;
    recipient: string;
    amount: bigint;
    confirmed: boolean;
  }>;
  moveIntoPool: PrivacyBridgeEngine["moveIntoPool"];
  cashOut: PrivacyBridgeEngine["cashOut"];
  fundAccountFromPool: PrivacyBridgeEngine["fundAccountFromPool"];
  returnToPool: PrivacyBridgeEngine["returnToPool"];
}

/**
 * Adapts the official StarkWare bridge package to this SDK and validates the
 * package's deliberately unbranded string address/key outputs at runtime.
 */
export function createStarkwarePrivacyBridgeEngine(
  bridge: StarkwarePrivacyBridgeExports,
): PrivacyBridgeEngine {
  return {
    deriveEvmOwner(signature, accountIndex, channel) {
      const derived = bridge.derivePolygonEoa(signature, accountIndex, channel);
      if (!isAddress(derived.address)) {
        throw new Error("privacy bridge derived an invalid EVM owner address");
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(derived.privateKey)) {
        throw new Error(
          "privacy bridge derived an invalid EVM owner private key",
        );
      }
      return {
        address: getAddress(derived.address),
        privateKey: derived.privateKey as Hex,
      };
    },
    async readPrivateBalance(signature) {
      const privateKey = bridge.deriveStarknetPrivateKey(signature);
      const account = bridge.deriveStarknetAccount(
        privateKey,
        bridge.getActiveConfig().ozClassHash,
      );
      return bridge.discoverPrivateBalanceForAddress({
        snAddress: account.address,
        viewingKey: bridge.deriveViewingKey(signature),
      });
    },
    async readPendingDeposit(signature) {
      const privateKey = bridge.deriveStarknetPrivateKey(signature);
      const account = bridge.deriveStarknetAccount(
        privateKey,
        bridge.getActiveConfig().ozClassHash,
      );
      return bridge.readUndepositedResidual(account.address);
    },
    deriveStarknetAddress(signature) {
      const privateKey = bridge.deriveStarknetPrivateKey(signature);
      return bridge.deriveStarknetAccount(
        privateKey,
        bridge.getActiveConfig().ozClassHash,
      ).address;
    },
    quoteCctpOut: ({ amount, destinationDomain, fast }) =>
      bridge.fetchForwardMaxFee(amount, {
        fast,
        destDomain: destinationDomain,
      }),
    async bridgeOutToDeposit(args) {
      if (!isAddress(args.destination)) {
        throw new Error("CCTP destination must be a valid EVM address");
      }
      const viewingKey = bridge.deriveViewingKey(args.signature);
      const accountNonce = bridge.deriveAccountNonce(
        viewingKey,
        args.accountIndex,
        args.channel,
      );
      const result = await bridge.bridgeOut({
        signature: args.signature,
        accountIndex: args.accountIndex,
        accountNonce,
        amount: args.amount,
        channel: args.channel,
        minFinalityThreshold: args.fee.finalityThreshold,
        quotedFinalityThreshold: args.fee.finalityThreshold,
        maxFee: args.fee.maxFee,
        destChainId: args.destinationChainId,
        resolveDepositWallet: async () => args.destination,
        ...(args.onStatus ? { onStatus: args.onStatus } : {}),
      });
      if (!isAddress(result.mintRecipient) || !isAddress(result.eoaAddress)) {
        throw new Error("privacy bridge returned an invalid CCTP address");
      }
      if (getAddress(result.mintRecipient) !== getAddress(args.destination)) {
        throw new Error("privacy bridge changed the strict CCTP destination");
      }
      return {
        ...result,
        mintRecipient: getAddress(result.mintRecipient),
        eoaAddress: getAddress(result.eoaAddress),
      };
    },
    sendPrivateToStarknet: (args) =>
      bridge.sendPrivateToStarknet({
        resolveSignature: async () => args.signature,
        amount: args.amount,
        recipient: args.recipient,
        ...(args.onStatus ? { onStatus: args.onStatus } : {}),
      }),
    moveIntoPool: (args) => bridge.moveIntoPool(args),
    cashOut: (args) => bridge.cashOut(args),
    fundAccountFromPool: (args) => bridge.fundAccountFromPool(args),
    returnToPool: (args) => bridge.returnToPool(args),
  };
}
