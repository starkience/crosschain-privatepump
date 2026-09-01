import {
  decodeEventLog,
  getAddress,
  isAddressEqual,
  parseAbiItem,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import {
  PONS_V2_ROBINHOOD,
  ponsV2FactoryAbi,
  type PrivateLaunchpadClient,
  type PrivateLaunchpadSession,
} from "@private-launchpad/sdk";
import type { PrivatePosition } from "./positions.js";

const PRIVATE_FACTORY_DEPLOYMENT_BLOCK = 48_000_000n;
const MAX_LOG_BLOCK_RANGE = 50_000n;
const MIN_LOG_BLOCK_RANGE = 500n;
const ACCOUNT_CREATED_EVENT = parseAbiItem(
  "event AccountCreated(address indexed account, address indexed owner, uint256 indexed index)",
);
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const TOKEN_LAUNCHED_EVENT = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
);

const tokenMetadataAbi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "logo",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "description",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

interface RecoveryOptions {
  client: PrivateLaunchpadClient;
  signature: string;
  fromBlock?: bigint;
}

interface AccountCandidate extends PrivateLaunchpadSession {
  blockNumber: bigint;
  transactionHash: Hash;
}

/**
 * Rebuilds public recovery metadata without persisting or transmitting the
 * root signature. Candidate ownership is derived and matched inside the
 * browser; only already-public R2 accounts and token data are returned.
 */
export async function recoverPonsPositions({
  client,
  signature,
  fromBlock = PRIVATE_FACTORY_DEPLOYMENT_BLOCK,
}: RecoveryOptions): Promise<PrivatePosition[]> {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("identity signature must be hex");
  }

  const publicClient = client.config.publicClient;
  const latestBlock = await publicClient.getBlockNumber();
  const accountEvents = await getLogsInBlockRanges(
    fromBlock,
    latestBlock,
    (range) =>
      publicClient.getLogs({
        address: client.config.factory,
        event: ACCOUNT_CREATED_EVENT,
        ...range,
      }),
  );

  const accounts: AccountCandidate[] = [];
  for (const event of accountEvents) {
    const { account, owner, index } = event.args;
    if (
      !account ||
      !owner ||
      index === undefined ||
      event.blockNumber === null ||
      event.transactionHash === null ||
      index > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      continue;
    }
    const accountIndex = Number(index);
    const derived = client.config.bridge.deriveEvmOwner(
      signature,
      accountIndex,
      client.channel,
    );
    if (!isAddressEqual(derived.address as Address, owner)) continue;

    accounts.push({
      accountIndex,
      channel: client.channel,
      owner: getAddress(owner),
      account: getAddress(account),
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
    });
  }

  const recovered = await Promise.all(
    accounts.map((account) =>
      recoverAccountPositions(publicClient, account, latestBlock),
    ),
  );
  return recovered
    .flat()
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function readPonsTokenMetadata(
  publicClient: PublicClient,
  token: Address,
): Promise<{
  name: string;
  symbol: string;
  logo?: string;
  description?: string;
}> {
  const read = (functionName: "name" | "symbol" | "logo" | "description") =>
    publicClient.readContract({
      address: token,
      abi: tokenMetadataAbi,
      functionName,
    });
  const [name, symbol, logo, description] = await Promise.all([
    read("name").catch(() => ""),
    read("symbol").catch(() => ""),
    read("logo").catch(() => ""),
    read("description").catch(() => ""),
  ]);
  return {
    name: name.slice(0, 64),
    symbol: symbol.replace(/^\$/, "").slice(0, 24),
    ...(logo.trim() ? { logo: logo.trim().slice(0, 2_048) } : {}),
    ...(description.trim()
      ? { description: description.trim().slice(0, 512) }
      : {}),
  };
}

async function recoverAccountPositions(
  publicClient: PublicClient,
  session: AccountCandidate,
  latestBlock: bigint,
): Promise<PrivatePosition[]> {
  const [incomingTransfers, launches] = await Promise.all([
    getLogsInBlockRanges(session.blockNumber, latestBlock, (range) =>
      publicClient.getLogs({
        event: TRANSFER_EVENT,
        args: { to: session.account },
        ...range,
      }),
    ),
    getLogsInBlockRanges(session.blockNumber, latestBlock, (range) =>
      publicClient.getLogs({
        address: PONS_V2_ROBINHOOD.factory,
        event: TOKEN_LAUNCHED_EVENT,
        args: { deployer: session.account },
        ...range,
      }),
    ),
  ]);

  const launchByToken = new Map(
    launches.flatMap((event) => {
      const token = event.args.token;
      return token ? [[token.toLowerCase(), event] as const] : [];
    }),
  );
  const transferByToken = new Map<
    string,
    (typeof incomingTransfers)[number][]
  >();
  for (const transfer of incomingTransfers) {
    if (isAddressEqual(transfer.address, PONS_V2_ROBINHOOD.usdg)) continue;
    const key = transfer.address.toLowerCase();
    const current = transferByToken.get(key) ?? [];
    current.push(transfer);
    transferByToken.set(key, current);
  }

  const candidateTokens = new Set([
    ...launchByToken.keys(),
    ...transferByToken.keys(),
  ]);
  const positions: Array<PrivatePosition | undefined> = await Promise.all(
    [...candidateTokens].map(
      async (tokenKey): Promise<PrivatePosition | undefined> => {
        const token = getAddress(tokenKey);
        const [balance, launch, metadata] = await Promise.all([
          publicClient.readContract({
            address: token,
            abi: erc20BalanceAbi,
            functionName: "balanceOf",
            args: [session.account],
          }),
          publicClient
            .readContract({
              address: PONS_V2_ROBINHOOD.factory,
              abi: ponsV2FactoryAbi,
              functionName: "getLaunchedToken",
              args: [token],
            })
            .catch(() => undefined),
          readPonsTokenMetadata(publicClient, token),
        ]);
        if (
          !launch?.exists ||
          !isAddressEqual(launch.pairToken, PONS_V2_ROBINHOOD.usdg)
        ) {
          return undefined;
        }
        // A completed sale and return is no longer an open position. Local
        // records may continue to show it as closed, but recovery focuses on
        // custody that still requires the user's control.
        if (balance === 0n) return undefined;

        const tokenTransfers = transferByToken.get(tokenKey) ?? [];
        const transactionHashes = [
          ...new Set(
            tokenTransfers.flatMap((event) =>
              event.transactionHash ? [event.transactionHash] : [],
            ),
          ),
        ];
        const receipts = await Promise.all(
          transactionHashes.map((hash) =>
            publicClient.getTransactionReceipt({ hash }),
          ),
        );
        const usdgCommitted = receipts.reduce(
          (total, receipt) =>
            total + usdgSpentByAccount(receipt.logs, session.account),
          0n,
        );

        const launchEvent = launchByToken.get(tokenKey);
        const earliestBlock = [
          launchEvent?.blockNumber,
          ...tokenTransfers.map((event) => event.blockNumber),
        ].reduce<bigint | undefined>(
          (earliest, blockNumber) =>
            blockNumber !== null &&
            blockNumber !== undefined &&
            (earliest === undefined || blockNumber < earliest)
              ? blockNumber
              : earliest,
          undefined,
        );
        const block = earliestBlock
          ? await publicClient.getBlock({ blockNumber: earliestBlock })
          : undefined;
        const createdAt = block ? Number(block.timestamp) * 1_000 : Date.now();
        const buyTxHash = transactionHashes.at(-1);
        const launchTxHash = launchEvent?.transactionHash ?? undefined;
        const name = metadata.name || metadata.symbol || "Recovered Pons token";
        const symbol = metadata.symbol || "TOKEN";

        return {
          id: recoveredPositionId(session.account, token),
          kind: launchEvent ? "launch" : "trade",
          name,
          symbol,
          token,
          accountIndex: session.accountIndex,
          account: session.account,
          status: "held",
          usdcCommitted: usdgCommitted.toString(),
          tokenAmount: balance.toString(),
          ...(launchTxHash ? { launchTxHash } : {}),
          ...(buyTxHash ? { buyTxHash } : {}),
          createdAt,
          updatedAt: Date.now(),
        };
      },
    ),
  );

  return positions.filter(
    (position): position is PrivatePosition => position !== undefined,
  );
}

async function getLogsInBlockRanges<T>(
  fromBlock: bigint,
  toBlock: bigint,
  query: (range: {
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<readonly T[]>,
): Promise<T[]> {
  if (toBlock < fromBlock) return [];

  const logs: T[] = [];
  let cursor = fromBlock;
  let blockRange = MAX_LOG_BLOCK_RANGE;
  while (cursor <= toBlock) {
    const chunkEnd =
      cursor + blockRange - 1n < toBlock ? cursor + blockRange - 1n : toBlock;
    try {
      logs.push(...(await query({ fromBlock: cursor, toBlock: chunkEnd })));
      cursor = chunkEnd + 1n;
      if (blockRange < MAX_LOG_BLOCK_RANGE) {
        blockRange =
          blockRange * 2n > MAX_LOG_BLOCK_RANGE
            ? MAX_LOG_BLOCK_RANGE
            : blockRange * 2n;
      }
    } catch (error) {
      if (!isLogRangeTimeout(error)) throw error;
      const attemptedRange = chunkEnd - cursor + 1n;
      if (attemptedRange <= MIN_LOG_BLOCK_RANGE) {
        throw new Error(
          "Robinhood RPC timed out while scanning position history. Try recovery again shortly.",
          { cause: error },
        );
      }
      const reducedRange = attemptedRange / 2n;
      blockRange =
        reducedRange < MIN_LOG_BLOCK_RANGE ? MIN_LOG_BLOCK_RANGE : reducedRange;
    }
  }
  return logs;
}

function isLogRangeTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /log query timed out|eth_getLogs.*tim(?:e|ed) out|query timeout/i.test(
    message,
  );
}

function usdgSpentByAccount(
  logs: readonly {
    address: Address;
    data: `0x${string}`;
    topics: readonly Hex[];
  }[],
  account: Address,
): bigint {
  let total = 0n;
  for (const log of logs) {
    if (!isAddressEqual(log.address, PONS_V2_ROBINHOOD.usdg)) continue;
    if (log.topics.length === 0) continue;
    try {
      const decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
        strict: true,
      });
      if (
        decoded.eventName === "Transfer" &&
        isAddressEqual(decoded.args.from, account)
      ) {
        total += decoded.args.value;
      }
    } catch {
      // Ignore unrelated USDG events in the same transaction receipt.
    }
  }
  return total;
}

function recoveredPositionId(account: Address, token: Address): string {
  return `onchain-${account.slice(2, 12).toLowerCase()}-${token.slice(2, 12).toLowerCase()}`;
}
