import { describe, expect, it } from "vitest";
import { createPrivateLaunchpadIdentityMessage } from "./identity.js";

describe("identity message", () => {
  it("is stable and app scoped", () => {
    const first = createPrivateLaunchpadIdentityMessage("launch.example");
    expect(createPrivateLaunchpadIdentityMessage("launch.example")).toBe(first);
    expect(createPrivateLaunchpadIdentityMessage("other.example")).not.toBe(
      first,
    );
    expect(first).toContain("does not authorize");
  });

  it("rejects ambiguous ids", () => {
    expect(() =>
      createPrivateLaunchpadIdentityMessage("Launch Example"),
    ).toThrow(/appId/);
  });
});
