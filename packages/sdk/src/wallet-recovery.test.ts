import { describe, expect, it } from "vitest";
import { walletRecoveryMessage } from "./wallet-recovery.js";

const FACTORY = "0x1111111111111111111111111111111111111111" as const;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;
const ACCOUNT_A = "0x3333333333333333333333333333333333333333" as const;
const ACCOUNT_B = "0x4444444444444444444444444444444444444444" as const;

describe("direct wallet recovery message", () => {
  it("canonically sorts accounts and binds every recovery field", () => {
    expect(
      walletRecoveryMessage({
        chainId: 4663,
        factory: FACTORY,
        recipient: RECIPIENT,
        accounts: [
          { account: ACCOUNT_B, amount: 2n },
          { account: ACCOUNT_A, amount: 1n },
        ],
        deadline: 2_000_000_000n,
      }),
    ).toBe(
      [
        "PonsButPrivate direct wallet recovery",
        "",
        "This action publicly links the listed position accounts to your wallet.",
        "Chain ID: 4663",
        `Factory: ${FACTORY}`,
        `Recipient: ${RECIPIENT}`,
        "Deadline: 2000000000",
        "Accounts:",
        `${ACCOUNT_A}:1`,
        `${ACCOUNT_B}:2`,
      ].join("\n"),
    );
  });

  it("rejects duplicate source accounts and non-positive amounts", () => {
    expect(() =>
      walletRecoveryMessage({
        chainId: 4663,
        factory: FACTORY,
        recipient: RECIPIENT,
        accounts: [
          { account: ACCOUNT_A, amount: 1n },
          { account: ACCOUNT_A, amount: 2n },
        ],
        deadline: 2_000_000_000n,
      }),
    ).toThrow(/duplicate source/);
    expect(() =>
      walletRecoveryMessage({
        chainId: 4663,
        factory: FACTORY,
        recipient: RECIPIENT,
        accounts: [{ account: ACCOUNT_A, amount: 0n }],
        deadline: 2_000_000_000n,
      }),
    ).toThrow(/amount must be positive/);
  });
});
