import { describe, expect, it } from "vitest";
import { encodeErrorResult } from "viem";
import { privateLaunchpadAccountFactoryAbi } from "../../../packages/sdk/src/index.js";
import { boundedErrorMessage } from "./private-relayer.js";

const targetErrorAbi = [
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
] as const;

describe("private relayer errors", () => {
  it("keeps the revert reason without exposing signed call arguments", () => {
    const signature = `0x${"ab".repeat(65)}`;
    const message = boundedErrorMessage(
      new Error(
        `The contract function "deployAndExecute" reverted.\n\nReason: InsufficientAllowance()\n\nContract Call:\n  signature: ${signature}`,
      ),
    );

    expect(message).toContain("Reason: InsufficientAllowance()");
    expect(message).not.toContain("Contract Call");
    expect(message).not.toContain(signature);
  });

  it("redacts unusually long hex values and bounds the response", () => {
    const message = boundedErrorMessage(
      new Error(`policy rejected 0x${"cd".repeat(500)}`),
    );

    expect(message).toContain("[redacted hex]");
    expect(message.length).toBeLessThanOrEqual(800);
  });

  it("decodes a nested execution-account failure without exposing calldata", () => {
    const nested = encodeErrorResult({
      abi: targetErrorAbi,
      errorName: "ERC20InsufficientBalance",
      args: ["0x1111111111111111111111111111111111111111", 0n, 1_764_547n],
    });
    const raw = encodeErrorResult({
      abi: privateLaunchpadAccountFactoryAbi,
      errorName: "CallFailed",
      args: [1n, nested],
    });
    const error = Object.assign(
      new Error('The contract function "deployAndExecute" reverted.'),
      { cause: { raw } },
    );

    expect(boundedErrorMessage(error)).toBe(
      'The contract function "deployAndExecute" reverted: execution call 2 failed: ERC20InsufficientBalance(available 0, required 1764547)',
    );
  });
});
