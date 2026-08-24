import { describe, expect, it } from "vitest";
import { flowReducer, initialFlowState, type FlowEvent } from "./flow.js";

describe("private launch flow", () => {
  it("advances only through the verified lifecycle", () => {
    const events: FlowEvent[] = [
      { type: "PREPARE" },
      { type: "IDENTITY_READY" },
      { type: "FUNDED" },
      { type: "LAUNCH" },
      { type: "LAUNCHED" },
      { type: "RETURN" },
      { type: "RETURNED" },
    ];
    const result = events.reduce(flowReducer, initialFlowState);
    expect(result).toEqual({ stage: "returned" });
  });

  it("ignores an out-of-order launch", () => {
    expect(flowReducer(initialFlowState, { type: "LAUNCH" })).toEqual(
      initialFlowState,
    );
  });

  it("retains the current stage when a runtime call fails", () => {
    expect(
      flowReducer({ stage: "bridging" }, { type: "FAIL", error: "timeout" }),
    ).toEqual({ stage: "bridging", error: "timeout" });
  });
});
