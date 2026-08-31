import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  parseAbiParameters,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ExecutionCall, RelayerFee } from "./types.js";

const CALL_TYPEHASH = keccak256(
  stringToHex("Call(address target,uint256 value,bytes data)"),
);

export const DEFAULT_EXECUTION_DOMAIN_NAME = "PrivateLaunchpadAccount";

export const executionTypes = {
  Execution: [
    { name: "callsHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "feeToken", type: "address" },
    { name: "feeAmount", type: "uint256" },
    { name: "feeRecipient", type: "address" },
    { name: "prefund", type: "uint256" },
  ],
} as const;

export function hashExecutionCalls(calls: readonly ExecutionCall[]): Hex {
  const callHashes = calls.map((call) =>
    keccak256(
      encodeAbiParameters(
        parseAbiParameters("bytes32,address,uint256,bytes32"),
        [CALL_TYPEHASH, call.target, call.value, keccak256(call.data)],
      ),
    ),
  );
  return keccak256(
    `0x${callHashes.map((hash) => hash.slice(2)).join("")}` as Hex,
  );
}

export interface SignExecutionArgs {
  privateKey: Hex;
  executionDomainName?: string;
  chainId: number;
  account: Address;
  calls: readonly ExecutionCall[];
  nonce: bigint;
  deadline: bigint;
  fee: RelayerFee;
  prefund: bigint;
}

export function executionTypedData(
  args: Omit<SignExecutionArgs, "privateKey">,
) {
  return {
    domain: {
      name: args.executionDomainName ?? DEFAULT_EXECUTION_DOMAIN_NAME,
      version: "1",
      chainId: args.chainId,
      verifyingContract: args.account,
    },
    types: executionTypes,
    primaryType: "Execution" as const,
    message: {
      callsHash: hashExecutionCalls(args.calls),
      nonce: args.nonce,
      deadline: args.deadline,
      feeToken: args.fee.token,
      feeAmount: args.fee.amount,
      feeRecipient: args.fee.recipient,
      prefund: args.prefund,
    },
  };
}

export function executionDigest(
  args: Omit<SignExecutionArgs, "privateKey">,
): Hex {
  return hashTypedData(executionTypedData(args));
}

export async function signExecution(args: SignExecutionArgs): Promise<Hex> {
  const signer = privateKeyToAccount(args.privateKey);
  return signer.signTypedData(executionTypedData(args));
}
