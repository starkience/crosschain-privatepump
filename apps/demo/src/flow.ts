export type FlowStage =
  | "draft"
  | "identity"
  | "bridging"
  | "ready"
  | "launching"
  | "live"
  | "returning"
  | "returned";

export interface FlowState {
  stage: FlowStage;
  error?: string;
}

export type FlowEvent =
  | { type: "PREPARE" }
  | { type: "IDENTITY_READY" }
  | { type: "FUNDED" }
  | { type: "LAUNCH" }
  | { type: "LAUNCHED" }
  | { type: "RETURN" }
  | { type: "RETURNED" }
  | { type: "FAIL"; error: string }
  | { type: "RESET" };

const transitions: Partial<
  Record<FlowStage, Partial<Record<FlowEvent["type"], FlowStage>>>
> = {
  draft: { PREPARE: "identity" },
  identity: { IDENTITY_READY: "bridging" },
  bridging: { FUNDED: "ready" },
  ready: { LAUNCH: "launching" },
  launching: { LAUNCHED: "live" },
  live: { RETURN: "returning" },
  returning: { RETURNED: "returned" },
};

export const initialFlowState: FlowState = { stage: "draft" };

export function flowReducer(state: FlowState, event: FlowEvent): FlowState {
  if (event.type === "RESET") return initialFlowState;
  if (event.type === "FAIL") return { ...state, error: event.error };
  const next = transitions[state.stage]?.[event.type];
  return next ? { stage: next } : state;
}

export const activeStages = new Set<FlowStage>([
  "identity",
  "bridging",
  "launching",
  "returning",
]);
