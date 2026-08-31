// @vitest-environment node

import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryStarkscanProverStateStore,
  createStarkscanProverStateStore,
} from "./starkscan-prover-store.js";

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");

describe("Starkscan encrypted proof state store", () => {
  it("round-trips encrypted values through a Redis-compatible REST API", async () => {
    const values = new Map<string, string>();
    const requests: string[] = [];
    const fetchImpl = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit) => {
        const raw = String(init?.body);
        requests.push(raw);
        const command = JSON.parse(raw) as string[];
        if (command[0] === "SET") {
          values.set(command[1]!, command[2]!);
          return Response.json({ result: "OK" });
        }
        return Response.json({ result: values.get(command[1]!) ?? null });
      },
    );
    const store = createStarkscanProverStateStore({
      endpoint: "https://proof-state.example",
      token: "redis-secret",
      encryptionKey: ENCRYPTION_KEY,
      fetchImpl,
    });

    await store.set(
      "proof:0123456789abcdef:terminal:0",
      { proof: "private-proof", additional_data: { signature: "sensitive" } },
      300,
    );

    await expect(
      store.get("proof:0123456789abcdef:terminal:0"),
    ).resolves.toEqual({
      proof: "private-proof",
      additional_data: { signature: "sensitive" },
    });
    expect(requests.join("\n")).not.toContain("private-proof");
    expect(requests.join("\n")).not.toContain("sensitive");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const headers = new Headers(fetchImpl.mock.calls[0]![1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer redis-secret");
  });

  it("rejects malformed encryption keys before contacting the store", () => {
    expect(() =>
      createStarkscanProverStateStore({
        endpoint: "https://proof-state.example",
        token: "redis-secret",
        encryptionKey: "too-short",
      }),
    ).toThrow("exactly 32 bytes");
  });

  it("expires process-local development records", async () => {
    let now = 1_000;
    const store = createMemoryStarkscanProverStateStore(() => now);
    await store.set("proof:0123456789abcdef:cursor", { attempt: 0 }, 2);
    await expect(store.get("proof:0123456789abcdef:cursor")).resolves.toEqual({
      attempt: 0,
    });
    now = 3_000;
    await expect(
      store.get("proof:0123456789abcdef:cursor"),
    ).resolves.toBeUndefined();
  });
});
