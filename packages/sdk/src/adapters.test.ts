import { describe, expect, it } from "vitest";
import { approveCall, preparedCallsAdapter } from "./adapters.js";

describe("launchpad adapters", () => {
  it("builds a standard ERC-20 approval", () => {
    const call = approveCall(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      123n,
    );
    expect(call.target).toBe("0x1111111111111111111111111111111111111111");
    expect(call.value).toBe(0n);
    expect(call.data.startsWith("0x095ea7b3")).toBe(true);
  });

  it("rejects an empty host call plan", async () => {
    const adapter = preparedCallsAdapter("host", 84532);
    await expect(
      adapter.buildOpenCalls(
        { calls: [] },
        {
          account: "0x1111111111111111111111111111111111111111",
          publicClient: {} as never,
        },
      ),
    ).rejects.toThrow(/no calls/);
  });
});
