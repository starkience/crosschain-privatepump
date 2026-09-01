import { describe, expect, it } from "vitest";
import { boundedErrorMessage } from "./private-relayer.js";

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
});
