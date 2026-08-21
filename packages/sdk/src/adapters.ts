import { encodeFunctionData, type Address, type Hex } from "viem";
import { erc20Abi } from "./abi.js";
import type { ExecutionCall, LaunchpadAdapter } from "./types.js";

export function approveCall(
  token: Address,
  spender: Address,
  amount: bigint,
): ExecutionCall {
  return {
    target: token,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    }),
  };
}

export function contractCall(
  target: Address,
  data: Hex,
  value = 0n,
): ExecutionCall {
  return { target, value, data };
}

export interface PreparedLaunchpadIntent {
  calls: readonly ExecutionCall[];
}

/// Adapter for hosts that already expose an SDK/API returning ready-to-sign calls.
/// It is intentionally thin: venue pricing, slippage, allowlists, and lifecycle
/// rules remain authoritative in the host SDK.
export function preparedCallsAdapter(
  id: string,
  chainId: number,
): LaunchpadAdapter<PreparedLaunchpadIntent> {
  if (!id.trim()) throw new Error("adapter id must not be empty");
  return {
    id,
    chainId,
    async buildOpenCalls(intent) {
      return validateCalls(intent.calls);
    },
    async buildCloseCalls(intent) {
      return validateCalls(intent.calls);
    },
  };
}

function validateCalls(
  calls: readonly ExecutionCall[],
): readonly ExecutionCall[] {
  if (calls.length === 0)
    throw new Error("launchpad adapter produced no calls");
  for (const [index, call] of calls.entries()) {
    if (call.target === "0x0000000000000000000000000000000000000000") {
      throw new Error(`launchpad adapter call ${index} has a zero target`);
    }
    if (call.value < 0n)
      throw new Error(`launchpad adapter call ${index} has negative value`);
  }
  return calls;
}
