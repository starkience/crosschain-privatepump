import { getAddress, isAddress, type Address } from "viem";
import type { WalletRecoveryEntry } from "./types.js";

export interface WalletRecoveryMessageArgs {
  chainId: number;
  factory: Address;
  recipient: Address;
  accounts: readonly WalletRecoveryEntry[];
  deadline: bigint;
}

/** Canonical, human-readable authorization for a public emergency recovery. */
export function walletRecoveryMessage(args: WalletRecoveryMessageArgs): string {
  if (!Number.isSafeInteger(args.chainId) || args.chainId <= 0) {
    throw new Error("wallet recovery chain must be a positive safe integer");
  }
  if (!isAddress(args.factory, { strict: true })) {
    throw new Error("wallet recovery factory must be an address");
  }
  if (!isAddress(args.recipient, { strict: true })) {
    throw new Error("wallet recovery recipient must be an address");
  }
  if (args.deadline <= 0n) {
    throw new Error("wallet recovery deadline must be positive");
  }
  if (args.accounts.length === 0 || args.accounts.length > 20) {
    throw new Error("wallet recovery must contain between 1 and 20 accounts");
  }

  const normalized = args.accounts
    .map((entry) => {
      if (!isAddress(entry.account, { strict: true })) {
        throw new Error("wallet recovery source must be an address");
      }
      if (entry.amount <= 0n) {
        throw new Error("wallet recovery amount must be positive");
      }
      return { account: getAddress(entry.account), amount: entry.amount };
    })
    .sort((left, right) =>
      left.account.toLowerCase().localeCompare(right.account.toLowerCase()),
    );
  if (
    new Set(normalized.map((entry) => entry.account.toLowerCase())).size !==
    normalized.length
  ) {
    throw new Error("wallet recovery contains a duplicate source account");
  }

  return [
    "PonsButPrivate direct wallet recovery",
    "",
    "This action publicly links the listed position accounts to your wallet.",
    `Chain ID: ${args.chainId}`,
    `Factory: ${getAddress(args.factory)}`,
    `Recipient: ${getAddress(args.recipient)}`,
    `Deadline: ${args.deadline}`,
    "Accounts:",
    ...normalized.map((entry) => `${entry.account}:${entry.amount.toString()}`),
  ].join("\n");
}
