import {
  createWalletClient,
  encodePacked,
  getAddress,
  http,
  isAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import type {
  Eip1193Provider,
  BridgeFundResult,
  CctpForwardFeeQuote,
  PrivateDepositTransport,
  SessionBatchReturnTransport,
  SessionFundingTransport,
  SessionReturnTransport,
} from "./types.js";

export const ARBITRUM_CHAIN_ID = 42161;
export const ARBITRUM_CCTP_DOMAIN = 3;
export const ARBITRUM_NATIVE_USDC = getAddress(
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
);
export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_USDG = getAddress(
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
);

const TRANSFER_SELECTOR = "0xa9059cbb";
const DEFAULT_CURSOR_KEY = "private-pons.relay-funding.v1";
const DEFAULT_PRIVATE_TRANSFER_FEE_BUFFER = 500_000n;
const DERIVED_RPC_READ_ATTEMPTS = 4;
const DERIVED_RPC_RETRY_BASE_MS = 250;
const SOURCE_BROADCAST_ATTEMPTS = 5;
const SOURCE_BROADCAST_POLL_MS = 4_000;

export class RobinhoodTransactionNotFoundError extends Error {
  constructor(readonly transactionHash: string) {
    super(
      `MetaMask returned transaction ${transactionHash}, but Robinhood never received it. The USDG transfer was not broadcast, so Relay and STRK20 did not start. Restart Chrome and unlock MetaMask before retrying.`,
    );
    this.name = "RobinhoodTransactionNotFoundError";
  }
}

export interface RelayBridgeQuote {
  requestId: string;
  /** Short-lived policy binding added by the trusted same-origin proxy. */
  quoteAttestation?: string;
  inputAmount: bigint;
  outputAmount: bigint;
  minimumOutputAmount: bigint;
  depositAddress: Address;
  depositTransaction: {
    chainId: number;
    from: Address;
    to: Address;
    data: Hex;
    value: Hex;
  };
  timeEstimateSeconds?: number;
}

export interface RelayBridgeStatus {
  status: string;
  terminal: boolean;
  succeeded: boolean;
  destinationTxHash?: Hex;
}

export interface RelayBridgeClientOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface RelayBridgeClient {
  quoteArbitrumUsdcToRobinhoodUsdg(args: {
    user: Address;
    recipient: Address;
    refundTo: Address;
    amount: bigint;
    slippageBps?: number;
  }): Promise<RelayBridgeQuote>;
  quoteRobinhoodUsdgToArbitrumUsdc(args: {
    user: Address;
    recipient: Address;
    refundTo: Address;
    amount: bigint;
    slippageBps?: number;
    topupGas?: boolean;
    topupGasAmount?: bigint;
  }): Promise<RelayBridgeQuote>;
  getStatus(requestId: string): Promise<RelayBridgeStatus>;
  waitForSuccess(
    requestId: string,
    onStatus?: (status: RelayBridgeStatus) => void,
  ): Promise<RelayBridgeStatus>;
}

export interface RelayFundingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RelayFundingTransportOptions {
  relay: RelayBridgeClient;
  storage?: RelayFundingStorage;
  cursorKey?: string;
  privateTransferFeeBuffer?: bigint;
}

export interface RelayDepositTransportOptions {
  relay: RelayBridgeClient;
  arbitrumRpcUrl?: string;
  robinhoodRpcUrl?: string;
  inboundChannel?: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  sourceBroadcastAttempts?: number;
  sourceBroadcastPollMs?: number;
}

export interface RelayReturnTransportOptions extends RelayDepositTransportOptions {
  privateTransferFeeBuffer?: bigint;
}

interface FundingCursor {
  version: 2;
  recoveryScope: Hex;
  requestId: string;
  burnTxHash: string;
  amount: string;
  outputAmount: string;
  minimumOutputAmount: string;
  depositAddress: Address;
  sessionAccount: Address;
  sessionOwner: Address;
  accountIndex: number;
  channel: string;
  commitmentH: string;
  createdAt: number;
}

export function createRelayBridgeClient(
  options: RelayBridgeClientOptions = {},
): RelayBridgeClient {
  const endpoint = (options.endpoint ?? "/api/relay").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 20 * 60_000;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  return {
    quoteArbitrumUsdcToRobinhoodUsdg(args) {
      return quoteStrictDepositRoute(doFetch, endpoint, {
        user: getAddress(args.user),
        originChainId: ARBITRUM_CHAIN_ID,
        destinationChainId: ROBINHOOD_CHAIN_ID,
        originCurrency: ARBITRUM_NATIVE_USDC,
        destinationCurrency: ROBINHOOD_USDG,
        amount: args.amount.toString(),
        recipient: getAddress(args.recipient),
        tradeType: "EXACT_INPUT",
        useDepositAddress: true,
        refundTo: getAddress(args.refundTo),
        slippageTolerance: String(args.slippageBps ?? 100),
        strict: true,
      });
    },

    quoteRobinhoodUsdgToArbitrumUsdc(args) {
      const topupGas = args.topupGas ?? true;
      return quoteStrictDepositRoute(doFetch, endpoint, {
        user: getAddress(args.user),
        originChainId: ROBINHOOD_CHAIN_ID,
        destinationChainId: ARBITRUM_CHAIN_ID,
        originCurrency: ROBINHOOD_USDG,
        destinationCurrency: ARBITRUM_NATIVE_USDC,
        amount: args.amount.toString(),
        recipient: getAddress(args.recipient),
        tradeType: "EXACT_INPUT",
        useDepositAddress: true,
        refundTo: getAddress(args.refundTo),
        slippageTolerance: String(args.slippageBps ?? 100),
        strict: true,
        ...(topupGas
          ? {
              topupGas: true,
              topupGasAmount: (args.topupGasAmount ?? 250_000n).toString(),
            }
          : {}),
      });
    },

    async getStatus(requestId) {
      assertRequestId(requestId);
      const response = await doFetch(
        `${endpoint}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`,
        { headers: { accept: "application/json" } },
      );
      const body = await responseJson(response, "Relay status");
      if (!response.ok)
        throw relayHttpError("Relay status", response.status, body);
      return validateRelayStatus(body);
    },

    async waitForSuccess(requestId, onStatus) {
      const deadline = Date.now() + timeoutMs;
      let previous = "";
      while (Date.now() <= deadline) {
        let status: RelayBridgeStatus;
        try {
          status = await this.getStatus(requestId);
        } catch (error) {
          if (!isRetryableRelayStatusError(error)) throw error;
          await sleep(pollIntervalMs);
          continue;
        }
        if (status.status !== previous || status.terminal) {
          onStatus?.(status);
          previous = status.status;
        }
        if (status.succeeded) return status;
        if (status.terminal) {
          throw new Error(`Relay transfer ended with status ${status.status}`);
        }
        await sleep(pollIntervalMs);
      }
      throw new Error(
        `Relay transfer ${requestId} did not finish within ${Math.ceil(timeoutMs / 60_000)} minutes`,
      );
    },
  };
}

/** Public R1 USDG -> Relay -> domain-separated Arbitrum A1 -> CCTP -> STRK20. */
export function createRelayDepositTransport(
  options: RelayDepositTransportOptions,
): PrivateDepositTransport {
  const inboundChannel = options.inboundChannel ?? "pons-inbound-v1";
  const arbitrumRpcUrl = options.arbitrumRpcUrl ?? "/arbitrum-rpc";
  const robinhoodRpcUrl = options.robinhoodRpcUrl ?? "/robinhood-rpc";
  const fetchImpl = options.fetch ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const sourceBroadcastAttempts =
    options.sourceBroadcastAttempts ?? SOURCE_BROADCAST_ATTEMPTS;
  const sourceBroadcastPollMs =
    options.sourceBroadcastPollMs ?? SOURCE_BROADCAST_POLL_MS;
  return async (args) => {
    const accounts = await args.provider.request({
      method: "eth_requestAccounts",
    });
    if (!Array.isArray(accounts) || !isAddress(accounts[0])) {
      throw new Error("wallet did not return a Robinhood account");
    }
    const connected = getAddress(accounts[0]);
    const staging = args.bridge.deriveEvmOwner(
      args.signature,
      0,
      inboundChannel,
    );
    const localProvider = createDerivedEip1193Provider({
      privateKey: staging.privateKey,
      rpcUrl: arbitrumRpcUrl,
    });

    // The official bridge owns the durable CCTP cursor. Once the Arbitrum
    // burn has happened the staging balance is expected to be zero, so a
    // resume must delegate immediately instead of requiring that balance to
    // still exist.
    if (args.resume) {
      return args.bridge.moveIntoPool({
        signature: args.signature as Hex,
        funding: "metamask",
        amountWei: args.amount,
        provider: localProvider,
        sourceChainId: ARBITRUM_CHAIN_ID,
        resume: true,
        ...(args.onStep ? { onStep: args.onStep } : {}),
      });
    }

    let delivered = 0n;
    args.onStep?.(
      "deploy",
      "running",
      "bridging USDG to a private Arbitrum staging account",
    );
    const quote = await options.relay.quoteRobinhoodUsdgToArbitrumUsdc({
      user: connected,
      recipient: staging.address,
      refundTo: connected,
      amount: args.amount,
    });
    const sourceTxHash = await args.provider.request({
      method: "eth_sendTransaction",
      params: [quote.depositTransaction],
    });
    if (
      typeof sourceTxHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(sourceTxHash)
    ) {
      throw new Error(
        "wallet did not return a Robinhood deposit transaction hash",
      );
    }
    args.onBurned?.({
      burnTxHash: sourceTxHash,
      explorerUrl: `https://robinhoodchain.blockscout.com/tx/${sourceTxHash}`,
    });
    await waitForRobinhoodBroadcast({
      transactionHash: sourceTxHash,
      rpcUrl: robinhoodRpcUrl,
      fetch: fetchImpl,
      sleep,
      attempts: sourceBroadcastAttempts,
      pollMs: sourceBroadcastPollMs,
    });
    await options.relay.waitForSuccess(quote.requestId, (status) =>
      args.onStep?.(
        "deploy",
        status.succeeded ? "done" : "running",
        status.status,
      ),
    );
    delivered = await readUsdcBalance(localProvider, staging.address);
    if (delivered < quote.minimumOutputAmount) {
      throw new Error(
        `Relay delivered ${delivered} Arbitrum USDC, below quoted minimum ${quote.minimumOutputAmount}`,
      );
    }
    if (delivered <= 0n) {
      throw new Error(
        "no Arbitrum USDC is available to resume the STRK20 deposit",
      );
    }
    return args.bridge.moveIntoPool({
      signature: args.signature as Hex,
      funding: "metamask",
      amountWei: delivered,
      provider: localProvider,
      sourceChainId: ARBITRUM_CHAIN_ID,
      ...(args.onStep ? { onStep: args.onStep } : {}),
    });
  };
}

async function waitForRobinhoodBroadcast(args: {
  transactionHash: string;
  rpcUrl: string;
  fetch: typeof fetch;
  sleep(milliseconds: number): Promise<void>;
  attempts: number;
  pollMs: number;
}): Promise<void> {
  if (!Number.isSafeInteger(args.attempts) || args.attempts <= 0) {
    throw new Error("source broadcast attempts must be a positive integer");
  }
  if (!Number.isSafeInteger(args.pollMs) || args.pollMs < 0) {
    throw new Error("source broadcast poll interval must be non-negative");
  }
  let missingChecks = 0;
  let lastReadError: unknown;
  for (let attempt = 0; attempt < args.attempts; attempt += 1) {
    try {
      const response = await args.fetch(args.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: attempt + 1,
          method: "eth_getTransactionByHash",
          params: [args.transactionHash],
        }),
      });
      const payload = object(
        await responseJson(response, "Robinhood transaction lookup"),
        "Robinhood transaction lookup",
      );
      if (!response.ok || payload.error) {
        const rpcError = objectOrNull(payload.error);
        const detail =
          typeof rpcError?.message === "string"
            ? rpcError.message
            : `HTTP ${response.status}`;
        throw new Error(`Robinhood transaction lookup failed: ${detail}`);
      }
      if (objectOrNull(payload.result)) return;
      missingChecks += 1;
    } catch (error) {
      lastReadError = error;
    }
    if (attempt + 1 < args.attempts) await args.sleep(args.pollMs);
  }
  if (missingChecks === args.attempts) {
    throw new RobinhoodTransactionNotFoundError(args.transactionHash);
  }
  throw new Error(
    "Could not verify whether Robinhood received the MetaMask transaction. Relay and STRK20 were not started; retry the status check shortly.",
    { cause: lastReadError },
  );
}

/**
 * Returns Pons USDG through a position-specific Arbitrum account and a distinct
 * STRK20 S2 identity, then privately transfers the note from S2 back to S1.
 */
export function createRelayReturnTransport(
  options: RelayReturnTransportOptions,
): SessionReturnTransport {
  const arbitrumRpcUrl = options.arbitrumRpcUrl ?? "/arbitrum-rpc";
  const feeBuffer =
    options.privateTransferFeeBuffer ?? DEFAULT_PRIVATE_TRANSFER_FEE_BUFFER;
  return async (args) => {
    if (
      !args.bridge.deriveStarknetAddress ||
      !args.bridge.sendPrivateToStarknet
    ) {
      throw new Error(
        "official privacy bridge build lacks the private S2 return exports",
      );
    }
    const s2Signature = derivePrivateReturnSignature(
      args.signature as Hex,
      args.session.accountIndex,
    );
    const staging = args.bridge.deriveEvmOwner(
      s2Signature,
      args.session.accountIndex,
      "pons-return-staging-v1",
    );
    const localProvider = createDerivedEip1193Provider({
      privateKey: staging.privateKey,
      rpcUrl: arbitrumRpcUrl,
    });

    let delivered = 0n;
    if (args.amount > feeBuffer) {
      args.onStep?.(
        "relay-return",
        "running",
        "routing Pons USDG to the private return account",
      );
      let quote: RelayBridgeQuote;
      try {
        quote = await options.relay.quoteRobinhoodUsdgToArbitrumUsdc({
          user: args.session.account,
          recipient: staging.address,
          refundTo: args.session.owner,
          amount: args.amount,
        });
      } catch (error) {
        if (isRelayAmountTooLow(error)) {
          throw new Error(
            `Relay cannot return ${formatSixDecimalAmount(args.amount)} USDG right now because the amount is too low to cover swap fees and the Arbitrum gas top-up. The funds remain in the fresh Robinhood account; retry when Relay fees are lower.`,
            { cause: error },
          );
        }
        throw error;
      }
      if (BigInt(quote.depositTransaction.value) !== 0n) {
        throw new Error("Relay return unexpectedly requires native value");
      }
      const sourceTx = await args.submitCalls(
        [
          {
            target: quote.depositTransaction.to,
            value: 0n,
            data: quote.depositTransaction.data,
          },
        ],
        {
          relayRequestId: quote.requestId,
          relayQuoteAttestation: requiredQuoteAttestation(quote),
        },
      );
      const confirmation = await args.waitForExecution(sourceTx);
      if (confirmation.status !== "success") {
        throw new Error("Robinhood Relay deposit reverted");
      }
      await options.relay.waitForSuccess(quote.requestId, (status) =>
        args.onStep?.(
          "relay-return",
          status.succeeded ? "done" : "running",
          status.status,
        ),
      );
      delivered = await readUsdcBalance(localProvider, staging.address);
      if (delivered < quote.minimumOutputAmount) {
        throw new Error(
          "Relay return delivered less Arbitrum USDC than quoted",
        );
      }
    } else {
      delivered = await readUsdcBalance(localProvider, staging.address);
      if (delivered <= feeBuffer) {
        throw new Error(
          `No recoverable return was found: the Robinhood source has ${formatSixDecimalAmount(args.amount)} USDG and the isolated Arbitrum staging account has ${formatSixDecimalAmount(delivered)} USDC.`,
        );
      }
      args.onStep?.(
        "relay-return",
        "done",
        `resuming ${formatSixDecimalAmount(delivered)} USDC already delivered to the isolated return account`,
      );
    }

    args.onStep?.(
      "s2-deposit",
      "running",
      "depositing the return through an isolated S2 identity",
    );
    const deposited = await args.bridge.moveIntoPool({
      signature: s2Signature,
      funding: "metamask",
      amountWei: delivered,
      provider: localProvider,
      sourceChainId: ARBITRUM_CHAIN_ID,
    });
    if (!deposited.deposited || deposited.depositedNetWei <= feeBuffer) {
      throw new Error(
        "S2 did not receive enough private balance to complete the return",
      );
    }

    const recipient = args.bridge.deriveStarknetAddress(args.signature);
    const amountReturned = deposited.depositedNetWei - feeBuffer;
    args.onStep?.(
      "private-merge",
      "running",
      "privately merging S2 into the main balance",
    );
    const merged = await args.bridge.sendPrivateToStarknet({
      signature: s2Signature,
      amount: amountReturned,
      recipient,
      onStatus: (detail) => args.onStep?.("private-merge", "running", detail),
    });
    if (!merged.confirmed) {
      throw new Error(
        `private S2 merge was submitted but not confirmed: ${merged.txHash}`,
      );
    }
    args.onStep?.("private-merge", "done", merged.txHash);
    return {
      amountReturned,
      claimTxHash: merged.txHash,
      ranFreshBurn: true,
      alreadyClaimed: false,
    };
  };
}

/**
 * Returns several idle position balances through one isolated Arbitrum/S2
 * identity. Each Robinhood transfer still uses its own authenticated Relay
 * quote, while the gas top-up, STRK20 deposit, and private merge are shared.
 */
export function createRelayBatchReturnTransport(
  options: RelayReturnTransportOptions,
): SessionBatchReturnTransport {
  const arbitrumRpcUrl = options.arbitrumRpcUrl ?? "/arbitrum-rpc";
  const feeBuffer =
    options.privateTransferFeeBuffer ?? DEFAULT_PRIVATE_TRANSFER_FEE_BUFFER;

  return async (args) => {
    if (
      !args.bridge.deriveStarknetAddress ||
      !args.bridge.sendPrivateToStarknet
    ) {
      throw new Error(
        "official privacy bridge build lacks the private S2 return exports",
      );
    }
    const sources = [...args.sources]
      .filter((source) => source.amount > 0n)
      .sort((left, right) =>
        left.amount === right.amount ? 0 : left.amount > right.amount ? -1 : 1,
      );
    const indexes = new Set<number>();
    for (const source of sources) {
      if (indexes.has(source.session.accountIndex)) {
        throw new Error("batch return contains a duplicate position account");
      }
      indexes.add(source.session.accountIndex);
    }

    const s2Signature = derivePrivateReturnSignature(args.signature as Hex, 0);
    const staging = args.bridge.deriveEvmOwner(
      s2Signature,
      0,
      "pons-return-batch-staging-v1",
    );
    const localProvider = createDerivedEip1193Provider({
      privateKey: staging.privateKey,
      rpcUrl: arbitrumRpcUrl,
    });
    let delivered = await readUsdcBalance(localProvider, staging.address);
    if (sources.length === 0 && delivered === 0n) {
      return {
        amountReturned: 0n,
        claimTxHash: "",
        ranFreshBurn: false,
        alreadyClaimed: true,
        sourceAccountIndexes: [],
      };
    }
    let needsGasTopup =
      (await readNativeBalance(localProvider, staging.address)) === 0n;
    const sourceAccountIndexes: number[] = [];

    for (const [index, source] of sources.entries()) {
      args.onStep?.(
        "relay-return",
        "running",
        `routing idle USDG account ${index + 1} of ${sources.length}`,
      );
      let quote: RelayBridgeQuote;
      try {
        quote = await options.relay.quoteRobinhoodUsdgToArbitrumUsdc({
          user: source.session.account,
          recipient: staging.address,
          refundTo: source.session.owner,
          amount: source.amount,
          topupGas: needsGasTopup,
        });
      } catch (error) {
        if (isRelayAmountTooLow(error)) {
          throw new Error(
            `Relay cannot batch-return ${formatSixDecimalAmount(source.amount)} USDG from position account ${source.session.accountIndex} at current fees. No transfer was submitted for this account.`,
            { cause: error },
          );
        }
        throw error;
      }
      if (BigInt(quote.depositTransaction.value) !== 0n) {
        throw new Error(
          "Relay batch return unexpectedly requires native value",
        );
      }
      const sourceTx = await source.submitCalls(
        [
          {
            target: quote.depositTransaction.to,
            value: 0n,
            data: quote.depositTransaction.data,
          },
        ],
        {
          relayRequestId: quote.requestId,
          relayQuoteAttestation: requiredQuoteAttestation(quote),
        },
      );
      const confirmation = await source.waitForExecution(sourceTx);
      if (confirmation.status !== "success") {
        throw new Error("Robinhood Relay batch deposit reverted");
      }
      await options.relay.waitForSuccess(quote.requestId, (status) =>
        args.onStep?.(
          "relay-return",
          status.succeeded ? "done" : "running",
          `${index + 1}/${sources.length}: ${status.status}`,
        ),
      );
      const nextBalance = await readUsdcBalance(localProvider, staging.address);
      if (nextBalance < delivered + quote.minimumOutputAmount) {
        throw new Error(
          "Relay batch return delivered less Arbitrum USDC than quoted",
        );
      }
      delivered = nextBalance;
      needsGasTopup = false;
      sourceAccountIndexes.push(source.session.accountIndex);
    }

    if (delivered <= feeBuffer) {
      throw new Error(
        `The shared return account holds only ${formatSixDecimalAmount(delivered)} USDC; more than ${formatSixDecimalAmount(feeBuffer)} USDC is required for the final private merge. Funds remain recoverable in their current accounts.`,
      );
    }
    args.onStep?.(
      "s2-deposit",
      "running",
      "depositing the combined return through one isolated S2 identity",
    );
    const deposited = await args.bridge.moveIntoPool({
      signature: s2Signature,
      funding: "metamask",
      amountWei: delivered,
      provider: localProvider,
      sourceChainId: ARBITRUM_CHAIN_ID,
    });
    if (!deposited.deposited || deposited.depositedNetWei <= feeBuffer) {
      throw new Error(
        "S2 did not receive enough combined private balance to complete the return",
      );
    }

    const recipient = args.bridge.deriveStarknetAddress(args.signature);
    const amountReturned = deposited.depositedNetWei - feeBuffer;
    args.onStep?.(
      "private-merge",
      "running",
      "privately merging the combined S2 balance into the main balance",
    );
    const merged = await args.bridge.sendPrivateToStarknet({
      signature: s2Signature,
      amount: amountReturned,
      recipient,
      onStatus: (detail) => args.onStep?.("private-merge", "running", detail),
    });
    if (!merged.confirmed) {
      throw new Error(
        `private combined S2 merge was submitted but not confirmed: ${merged.txHash}`,
      );
    }
    args.onStep?.("private-merge", "done", merged.txHash);
    return {
      amountReturned,
      claimTxHash: merged.txHash,
      ranFreshBurn: true,
      alreadyClaimed: false,
      sourceAccountIndexes,
    };
  };
}

export function derivePrivateReturnSignature(
  signature: Hex,
  accountIndex: number,
): Hex {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("root privacy signature must be hex");
  }
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0) {
    throw new Error("return account index must be a non-negative safe integer");
  }
  return keccak256(
    encodePacked(
      ["string", "bytes", "uint256"],
      ["PRIVATE_PONS_RETURN_IDENTITY_V1", signature, BigInt(accountIndex)],
    ),
  );
}

export function createDerivedEip1193Provider(args: {
  privateKey: Hex;
  rpcUrl: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}): Eip1193Provider {
  const account = privateKeyToAccount(args.privateKey);
  const wallet = createWalletClient({
    account,
    chain: arbitrum,
    transport: http(args.rpcUrl),
  });
  const fetchImpl = args.fetch ?? fetch;
  const sleep =
    args.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let requestId = 0;
  return {
    async request(payload) {
      if (
        payload.method === "eth_accounts" ||
        payload.method === "eth_requestAccounts"
      ) {
        return [account.address];
      }
      if (payload.method === "eth_chainId")
        return `0x${ARBITRUM_CHAIN_ID.toString(16)}`;
      if (payload.method === "wallet_switchEthereumChain") return null;
      if (payload.method === "wallet_getCapabilities") return {};
      if (payload.method === "eth_sendTransaction") {
        const params = payload.params;
        const transaction = Array.isArray(params)
          ? object(params[0], "EVM transaction")
          : null;
        if (!transaction)
          throw new Error(
            "derived signer received invalid transaction parameters",
          );
        if (
          addressField(transaction.from, "EVM transaction sender") !==
          account.address
        ) {
          throw new Error(
            "derived signer refused a transaction for another account",
          );
        }
        return wallet.sendTransaction({
          account,
          chain: arbitrum,
          to: addressField(transaction.to, "EVM transaction target"),
          ...(typeof transaction.data === "string"
            ? { data: transaction.data as Hex }
            : {}),
          ...(hexQuantity(transaction.value) !== undefined
            ? { value: hexQuantity(transaction.value) }
            : {}),
          ...(hexQuantity(transaction.gas) !== undefined
            ? { gas: hexQuantity(transaction.gas) }
            : {}),
          ...(hexQuantity(transaction.nonce) !== undefined
            ? { nonce: Number(hexQuantity(transaction.nonce)) }
            : {}),
        });
      }
      let lastError: unknown;
      for (let attempt = 0; attempt < DERIVED_RPC_READ_ATTEMPTS; attempt += 1) {
        try {
          const response = await fetchImpl(args.rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: ++requestId,
              method: payload.method,
              ...(payload.params === undefined
                ? {}
                : { params: payload.params }),
            }),
          });
          const text = await response.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text) as unknown;
          } catch {
            throw new Error(
              `Arbitrum RPC ${payload.method} returned an empty or invalid JSON response (HTTP ${response.status})`,
            );
          }
          const body = object(parsed, "Arbitrum RPC response");
          if (!response.ok || body.error) {
            const error = objectOrNull(body.error);
            const detail =
              typeof error?.message === "string"
                ? error.message
                : typeof body.error === "string"
                  ? body.error
                  : undefined;
            throw new Error(detail ?? `Arbitrum RPC ${payload.method} failed`);
          }
          return body.result;
        } catch (error) {
          lastError = error;
          if (attempt + 1 >= DERIVED_RPC_READ_ATTEMPTS) throw error;
          await sleep(DERIVED_RPC_RETRY_BASE_MS * 2 ** attempt);
        }
      }
      throw lastError;
    },
  };
}

async function quoteStrictDepositRoute(
  doFetch: typeof fetch,
  endpoint: string,
  request: {
    user: Address;
    originChainId: number;
    destinationChainId: number;
    originCurrency: Address;
    destinationCurrency: Address;
    amount: string;
    recipient: Address;
    tradeType: "EXACT_INPUT";
    useDepositAddress: true;
    refundTo: Address;
    slippageTolerance: string;
    strict: true;
    topupGas?: boolean;
    topupGasAmount?: string;
  },
): Promise<RelayBridgeQuote> {
  const slippageBps = Number(request.slippageTolerance);
  if (BigInt(request.amount) <= 0n)
    throw new Error("Relay amount must be positive");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) {
    throw new Error("Relay slippage must be between 0 and 500 bps");
  }
  const response = await doFetch(`${endpoint}/quote/v2`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await responseJson(response, "Relay quote");
  if (!response.ok) throw relayHttpError("Relay quote", response.status, body);
  return validateRelayQuote(body, request);
}

/**
 * Composes an STRK20 withdrawal, Circle Fast CCTP forwarding to a strict Relay
 * deposit address, and Relay's Arbitrum USDC -> Robinhood USDG route.
 */
export function createRelayFundingTransport(
  options: RelayFundingTransportOptions,
): SessionFundingTransport {
  const storage = options.storage ?? browserStorage();
  const cursorKey = options.cursorKey ?? DEFAULT_CURSOR_KEY;
  const privateTransferFeeBuffer =
    options.privateTransferFeeBuffer ?? DEFAULT_PRIVATE_TRANSFER_FEE_BUFFER;

  return async (args): Promise<BridgeFundResult> => {
    if (!args.bridge.quoteCctpOut || !args.bridge.bridgeOutToDeposit) {
      throw new Error(
        "official privacy bridge build lacks the low-level CCTP funding exports",
      );
    }
    const recoveryScope = fundingRecoveryScope(args.signature);
    migrateLegacyCursor(
      storage,
      cursorKey,
      args.connectedEvmAddress,
      recoveryScope,
    );
    const prior = readCursor(storage, cursorKey, recoveryScope);
    if (prior) {
      assertCursorMatches(
        prior,
        args.session.account,
        args.session.accountIndex,
      );
      args.onStep?.("bridge", "done", `resuming CCTP burn ${prior.burnTxHash}`);
      args.onStep?.(
        "relay",
        "running",
        "waiting for private funding on Robinhood",
      );
      const status = await options.relay.waitForSuccess(
        prior.requestId,
        (next) =>
          args.onStep?.(
            "relay",
            next.succeeded ? "done" : "running",
            next.status,
          ),
      );
      clearCursor(storage, cursorKey, recoveryScope);
      return cursorResult(prior, status);
    }

    assertStorageWritable(storage, cursorKey);
    args.onStep?.("bridge", "running", "quoting Circle Fast CCTP fee");
    const fee = await args.bridge.quoteCctpOut({
      amount: args.amount,
      destinationDomain: ARBITRUM_CCTP_DOMAIN,
      fast: args.fast,
    });
    const relayInput = netAfterCctp(args.amount, fee);
    const quote = await options.relay.quoteArbitrumUsdcToRobinhoodUsdg({
      user: args.session.owner,
      recipient: args.session.account,
      refundTo: args.session.owner,
      amount: relayInput,
    });

    // Fail closed before the private withdrawal. A buy position is only safe
    // to create when its slippage-protected output can also fund the reverse
    // Relay route (including the Arbitrum gas top-up used by STRK20 return).
    const returnSignature = derivePrivateReturnSignature(
      args.signature as Hex,
      args.session.accountIndex,
    );
    const returnStaging = args.bridge.deriveEvmOwner(
      returnSignature,
      args.session.accountIndex,
      "pons-return-staging-v1",
    );
    args.onStep?.(
      "relay",
      "running",
      "checking that the funded amount can be returned privately",
    );
    let recoveryQuote: RelayBridgeQuote;
    try {
      recoveryQuote = await options.relay.quoteRobinhoodUsdgToArbitrumUsdc({
        user: args.session.account,
        recipient: returnStaging.address,
        refundTo: args.session.owner,
        amount: quote.minimumOutputAmount,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const reason = isRelayAmountTooLow(error)
        ? `${formatSixDecimalAmount(quote.minimumOutputAmount)} USDG is below Relay's current recovery minimum`
        : `Relay could not verify the recovery route: ${detail}`;
      throw new Error(
        `Relay recovery preflight failed before any funds moved: ${reason}. Increase the private buy amount and try again.`,
        { cause: error },
      );
    }
    if (recoveryQuote.minimumOutputAmount <= privateTransferFeeBuffer) {
      throw new Error(
        `Relay recovery preflight failed before any funds moved: the reverse route would deliver only ${formatSixDecimalAmount(recoveryQuote.minimumOutputAmount)} USDC, but the final private merge requires more than ${formatSixDecimalAmount(privateTransferFeeBuffer)} USDC. Increase the private buy amount and try again.`,
      );
    }

    args.onStep?.(
      "bridge",
      "running",
      "proving private withdrawal and burning USDC",
    );
    const burned = await args.bridge.bridgeOutToDeposit({
      signature: args.signature,
      accountIndex: args.session.accountIndex,
      amount: args.amount,
      destination: quote.depositAddress,
      destinationChainId: ARBITRUM_CHAIN_ID,
      channel: args.session.channel,
      fee,
      onStatus: (detail) => args.onStep?.("bridge", "running", detail),
    });
    const cursor: FundingCursor = {
      version: 2,
      recoveryScope,
      requestId: quote.requestId,
      burnTxHash: burned.burnTxHash,
      amount: args.amount.toString(),
      outputAmount: quote.outputAmount.toString(),
      minimumOutputAmount: quote.minimumOutputAmount.toString(),
      depositAddress: quote.depositAddress,
      sessionAccount: args.session.account,
      sessionOwner: args.session.owner,
      accountIndex: args.session.accountIndex,
      channel: args.session.channel,
      commitmentH: burned.commitmentH.toString(),
      createdAt: Date.now(),
    };
    writeCursor(storage, cursorKey, cursor);
    args.onStep?.("bridge", "done", burned.burnTxHash);
    args.onStep?.(
      "relay",
      "running",
      "Circle is forwarding USDC to Relay on Arbitrum",
    );
    const status = await options.relay.waitForSuccess(quote.requestId, (next) =>
      args.onStep?.("relay", next.succeeded ? "done" : "running", next.status),
    );
    clearCursor(storage, cursorKey, recoveryScope);
    return cursorResult(cursor, status);
  };
}

function validateRelayQuote(
  value: unknown,
  request: {
    user: Address;
    originChainId: number;
    destinationChainId: number;
    originCurrency: Address;
    destinationCurrency: Address;
    amount: string;
    recipient: Address;
  },
): RelayBridgeQuote {
  const root = object(value, "Relay quote");
  const requestId = stringField(root, "requestId", "Relay quote");
  assertRequestId(requestId);
  const details = object(root.details, "Relay quote details");
  const currencyIn = object(details.currencyIn, "Relay input currency");
  const currencyOut = object(details.currencyOut, "Relay output currency");
  assertCurrency(
    currencyIn,
    request.originChainId,
    request.originCurrency,
    "input",
  );
  assertCurrency(
    currencyOut,
    request.destinationChainId,
    request.destinationCurrency,
    "output",
  );
  const inputAmount = decimalBigInt(currencyIn.amount, "Relay input amount");
  const outputAmount = decimalBigInt(currencyOut.amount, "Relay output amount");
  const minimumOutputAmount = decimalBigInt(
    currencyOut.minimumAmount ?? currencyOut.amount,
    "Relay minimum output amount",
  );
  if (inputAmount !== BigInt(request.amount)) {
    throw new Error("Relay quote changed the requested input amount");
  }
  if (
    outputAmount <= 0n ||
    minimumOutputAmount <= 0n ||
    minimumOutputAmount > outputAmount
  ) {
    throw new Error("Relay quote returned an invalid output amount");
  }

  const steps = Array.isArray(root.steps) ? root.steps : [];
  const depositStep = steps.find(
    (step) => objectOrNull(step)?.id === "deposit",
  );
  const items = objectOrNull(depositStep)?.items;
  if (!Array.isArray(items) || items.length !== 1) {
    throw new Error("Relay strict quote must contain exactly one deposit item");
  }
  const transaction = object(
    object(items[0], "Relay deposit item").data,
    "Relay deposit transaction",
  );
  if (Number(transaction.chainId) !== request.originChainId) {
    throw new Error("Relay deposit transaction is on the wrong chain");
  }
  const token = addressField(transaction.to, "Relay deposit token");
  if (token !== getAddress(request.originCurrency)) {
    throw new Error("Relay deposit transaction targets the wrong token");
  }
  const from = addressField(transaction.from, "Relay deposit sender");
  if (from !== getAddress(request.user)) {
    throw new Error("Relay deposit transaction changed the quote user");
  }
  const transfer = decodeErc20Transfer(
    stringField(transaction, "data", "Relay deposit transaction") as Hex,
  );
  if (transfer.amount !== inputAmount) {
    throw new Error("Relay deposit calldata changed the quoted input amount");
  }
  const quoteAttestation =
    typeof root.privatePonsAttestation === "string" &&
    /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(root.privatePonsAttestation)
      ? root.privatePonsAttestation
      : undefined;
  return {
    requestId,
    ...(quoteAttestation ? { quoteAttestation } : {}),
    inputAmount,
    outputAmount,
    minimumOutputAmount,
    depositAddress: transfer.recipient,
    depositTransaction: {
      chainId: request.originChainId,
      from,
      to: token,
      data: stringField(
        transaction,
        "data",
        "Relay deposit transaction",
      ) as Hex,
      value:
        typeof transaction.value === "string" &&
        /^0x[0-9a-fA-F]+$/.test(transaction.value)
          ? (transaction.value as Hex)
          : (`0x${BigInt(String(transaction.value ?? "0")).toString(16)}` as Hex),
    },
    ...(Number.isFinite(Number(details.timeEstimate))
      ? { timeEstimateSeconds: Number(details.timeEstimate) }
      : {}),
  };
}

function requiredQuoteAttestation(quote: RelayBridgeQuote): string {
  if (!quote.quoteAttestation) {
    throw new Error(
      "Relay return quote is missing its policy attestation; refresh and retry before moving funds",
    );
  }
  return quote.quoteAttestation;
}

async function readUsdcBalance(
  provider: Eip1193Provider,
  account: Address,
): Promise<bigint> {
  const result = await provider.request({
    method: "eth_call",
    params: [
      {
        to: ARBITRUM_NATIVE_USDC,
        data: `0x70a08231${account.slice(2).padStart(64, "0")}`,
      },
      "latest",
    ],
  });
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) {
    throw new Error("Arbitrum USDC balance returned invalid data");
  }
  return BigInt(result);
}

async function readNativeBalance(
  provider: Eip1193Provider,
  account: Address,
): Promise<bigint> {
  const result = await provider.request({
    method: "eth_getBalance",
    params: [account, "latest"],
  });
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) {
    throw new Error("Arbitrum native balance returned invalid data");
  }
  return BigInt(result);
}

function hexQuantity(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("EVM transaction contains an invalid hex quantity");
  }
  return BigInt(value);
}

function validateRelayStatus(value: unknown): RelayBridgeStatus {
  const root = object(value, "Relay status");
  const status = stringField(root, "status", "Relay status").toLowerCase();
  const succeeded = ["success", "completed", "complete", "filled"].includes(
    status,
  );
  const terminal =
    succeeded ||
    [
      "failure",
      "failed",
      "refund",
      "refunded",
      "cancelled",
      "canceled",
      "expired",
    ].includes(status);
  const hashes = [
    root.destinationTxHash,
    objectOrNull(root.txHashes)?.destination,
    objectOrNull(root.txHashes)?.destinationTxHash,
  ];
  const destinationTxHash = hashes.find(
    (candidate): candidate is Hex =>
      typeof candidate === "string" && /^0x[0-9a-fA-F]{64}$/.test(candidate),
  );
  return {
    status,
    terminal,
    succeeded,
    ...(destinationTxHash ? { destinationTxHash } : {}),
  };
}

function decodeErc20Transfer(data: Hex): {
  recipient: Address;
  amount: bigint;
} {
  if (
    !/^0x[0-9a-fA-F]{136}$/.test(data) ||
    data.slice(0, 10).toLowerCase() !== TRANSFER_SELECTOR
  ) {
    throw new Error("Relay deposit calldata is not an exact ERC-20 transfer");
  }
  const recipientWord = data.slice(10, 74);
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(recipientWord)) {
    throw new Error("Relay deposit calldata has a malformed recipient");
  }
  const recipient = getAddress(`0x${recipientWord.slice(24)}`);
  const amount = BigInt(`0x${data.slice(74, 138)}`);
  if (amount <= 0n)
    throw new Error("Relay deposit transfer amount must be positive");
  return { recipient, amount };
}

function assertCurrency(
  value: Record<string, unknown>,
  chainId: number,
  address: Address,
  label: string,
): void {
  const metadata = objectOrNull(value.currency) ?? value;
  if (Number(metadata.chainId ?? value.chainId) !== chainId) {
    throw new Error(`Relay ${label} currency is on the wrong chain`);
  }
  if (
    addressField(
      metadata.address ?? value.address,
      `Relay ${label} currency`,
    ) !== getAddress(address)
  ) {
    throw new Error(`Relay ${label} currency address changed`);
  }
}

function netAfterCctp(amount: bigint, fee: CctpForwardFeeQuote): bigint {
  if (fee.maxFee < 0n || fee.maxFee >= amount) {
    throw new Error("Circle fee consumes the entire private funding amount");
  }
  return amount - fee.maxFee;
}

function cursorResult(
  cursor: FundingCursor,
  status: RelayBridgeStatus,
): BridgeFundResult {
  return {
    burnTxHash: cursor.burnTxHash,
    accountIndex: cursor.accountIndex,
    eoaAddress: cursor.sessionOwner,
    depositWallet: cursor.sessionAccount,
    commitmentH: BigInt(cursor.commitmentH),
    forwardTxHash: status.destinationTxHash ?? cursor.requestId,
    amountDelivered: BigInt(cursor.outputAmount),
    minimumAmountDelivered: BigInt(cursor.minimumOutputAmount),
    relayRequestId: cursor.requestId,
    relayStatus: status.status,
    channel: cursor.channel,
  };
}

function browserStorage(): RelayFundingStorage {
  if (typeof localStorage === "undefined") {
    throw new Error("Relay funding requires durable browser storage");
  }
  return localStorage;
}

function storageKey(cursorKey: string, recoveryScope: Hex): string {
  return `${cursorKey}:v2:${recoveryScope.toLowerCase()}`;
}

function assertStorageWritable(
  storage: RelayFundingStorage,
  cursorKey: string,
): void {
  const key = `${cursorKey}:probe`;
  const marker = `${Date.now()}`;
  try {
    storage.setItem(key, marker);
    if (storage.getItem(key) !== marker) throw new Error("read-back mismatch");
    storage.removeItem(key);
  } catch {
    throw new Error(
      "Private funding needs writable local storage so an in-flight CCTP burn cannot be repeated",
    );
  }
}

function readCursor(
  storage: RelayFundingStorage,
  cursorKey: string,
  recoveryScope: Hex,
): FundingCursor | undefined {
  const key = storageKey(cursorKey, recoveryScope);
  const raw = storage.getItem(key);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<FundingCursor>;
    if (
      value.version !== 2 ||
      value.recoveryScope?.toLowerCase() !== recoveryScope.toLowerCase() ||
      !isAddress(value.depositAddress ?? "") ||
      !isAddress(value.sessionAccount ?? "") ||
      !isAddress(value.sessionOwner ?? "") ||
      typeof value.requestId !== "string" ||
      typeof value.burnTxHash !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(value.burnTxHash) ||
      typeof value.amount !== "string" ||
      typeof value.outputAmount !== "string" ||
      typeof value.minimumOutputAmount !== "string" ||
      typeof value.commitmentH !== "string" ||
      typeof value.channel !== "string" ||
      !value.channel ||
      !Number.isSafeInteger(value.accountIndex) ||
      (value.accountIndex ?? -1) < 0
    ) {
      throw new Error("invalid cursor");
    }
    assertRequestId(value.requestId);
    BigInt(value.amount);
    BigInt(value.outputAmount);
    BigInt(value.minimumOutputAmount);
    BigInt(value.commitmentH);
    return value as FundingCursor;
  } catch {
    storage.removeItem(key);
    throw new Error(
      "The saved private-funding recovery record is corrupt; it was cleared to prevent a double burn",
    );
  }
}

function writeCursor(
  storage: RelayFundingStorage,
  cursorKey: string,
  cursor: FundingCursor,
): void {
  const key = storageKey(cursorKey, cursor.recoveryScope);
  storage.setItem(key, JSON.stringify(cursor));
  const saved = storage.getItem(key);
  if (!saved || !saved.includes(cursor.burnTxHash)) {
    throw new Error(
      "CCTP burn succeeded but its recovery record could not be persisted; keep this tab open",
    );
  }
}

function clearCursor(
  storage: RelayFundingStorage,
  cursorKey: string,
  recoveryScope: Hex,
): void {
  storage.removeItem(storageKey(cursorKey, recoveryScope));
}

function fundingRecoveryScope(signature: string): Hex {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("identity signature must be hex");
  }
  return keccak256(
    encodePacked(
      ["string", "bytes"],
      ["private-pons.relay-funding-recovery.v2", signature as Hex],
    ),
  );
}

function migrateLegacyCursor(
  storage: RelayFundingStorage,
  cursorKey: string,
  connectedAddress: Address,
  recoveryScope: Hex,
): void {
  const legacyKey = `${cursorKey}:${connectedAddress.toLowerCase()}`;
  const legacy = storage.getItem(legacyKey);
  if (!legacy) return;
  const nextKey = storageKey(cursorKey, recoveryScope);
  if (!storage.getItem(nextKey)) {
    try {
      const value = JSON.parse(legacy) as Record<string, unknown>;
      const { connectedAddress: _connectedAddress, ...rest } = value;
      storage.setItem(
        nextKey,
        JSON.stringify({ ...rest, version: 2, recoveryScope }),
      );
    } catch {
      throw new Error(
        "The legacy private-funding recovery record is corrupt; preserve it for manual recovery",
      );
    }
  }
  storage.removeItem(legacyKey);
}

function assertCursorMatches(
  cursor: FundingCursor,
  account: Address,
  accountIndex: number,
): void {
  if (
    getAddress(cursor.sessionAccount) !== getAddress(account) ||
    cursor.accountIndex !== accountIndex
  ) {
    throw new Error(
      "A different private account has an unfinished Relay transfer; finish recovery before starting another",
    );
  }
}

function assertRequestId(value: string): void {
  if (!/^[0-9A-Za-z._:-]{8,160}$/.test(value)) {
    throw new Error("Relay returned an invalid request id");
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  const result = objectOrNull(value);
  if (!result) throw new Error(`${label} is not an object`);
  return result;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const result = value[field];
  if (typeof result !== "string" || !result) {
    throw new Error(`${label} is missing ${field}`);
  }
  return result;
}

function addressField(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`${label} is not an EVM address`);
  }
  return getAddress(value);
}

function decimalBigInt(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(`${label} is not a base-unit integer`);
  }
  return BigInt(value);
}

async function responseJson(
  response: Response,
  label: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`);
  }
}

function relayHttpError(label: string, status: number, body: unknown): Error {
  const message = objectOrNull(body)?.message ?? objectOrNull(body)?.error;
  return new Error(
    `${label} failed with HTTP ${status}${typeof message === "string" ? `: ${message}` : ""}`,
  );
}

function isRetryableRelayStatusError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /returned non-JSON HTTP|failed with HTTP (?:429|5\d\d)|fetch failed|network|timed? ?out|timeout/i.test(
    message,
  );
}

function isRelayAmountTooLow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /amount too low(?: to cover swap fees and gas top[ -]?up)?/i.test(
    message,
  );
}

function formatSixDecimalAmount(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
