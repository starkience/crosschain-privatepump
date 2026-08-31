import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import {
  executionTypedData,
  hashExecutionCalls,
  signExecution,
} from "./execution.js";
import { NO_RELAYER_FEE, type ExecutionCall } from "./types.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}` as Hex;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;

describe("execution authorization", () => {
  const calls: ExecutionCall[] = [
    {
      target: "0x3333333333333333333333333333333333333333",
      value: 7n,
      data: "0x123456",
    },
  ];

  it("is deterministic and changes when a call changes", () => {
    const hash = hashExecutionCalls(calls);
    expect(hashExecutionCalls(calls)).toBe(hash);
    expect(hashExecutionCalls([{ ...calls[0]!, value: 8n }])).not.toBe(hash);
  });

  it("recovers the derived owner from the EIP-712 signature", async () => {
    const args = {
      privateKey: PRIVATE_KEY,
      chainId: 84532,
      account: ACCOUNT,
      calls,
      nonce: 0n,
      deadline: 2_000_000_000n,
      fee: NO_RELAYER_FEE,
      prefund: 0n,
    };
    const signature = await signExecution(args);
    const recovered = await recoverTypedDataAddress({
      ...executionTypedData(args),
      signature,
    });
    expect(recovered).toBe(privateKeyToAccount(PRIVATE_KEY).address);
  });

  it("supports a deployment-specific EIP-712 domain", async () => {
    const args = {
      privateKey: PRIVATE_KEY,
      executionDomainName: "PonsPrivacyAccount",
      chainId: 4663,
      account: ACCOUNT,
      calls,
      nonce: 0n,
      deadline: 2_000_000_000n,
      fee: NO_RELAYER_FEE,
      prefund: 0n,
    };
    const signature = await signExecution(args);
    const recovered = await recoverTypedDataAddress({
      ...executionTypedData(args),
      signature,
    });

    expect(executionTypedData(args).domain.name).toBe("PonsPrivacyAccount");
    expect(recovered).toBe(privateKeyToAccount(PRIVATE_KEY).address);
  });

  it("binds the fee and prefund into the authorization", () => {
    const base = {
      chainId: 84532,
      account: ACCOUNT,
      calls,
      nonce: 0n,
      deadline: 2_000_000_000n,
      fee: NO_RELAYER_FEE,
      prefund: 0n,
    };
    expect(executionTypedData({ ...base, prefund: 1n }).message).not.toEqual(
      executionTypedData(base).message,
    );
  });
});
