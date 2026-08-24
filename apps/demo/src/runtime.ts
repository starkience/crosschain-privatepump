import {
  createPrivateLaunchpadIdentityMessage,
  type BridgeFundResult,
  type BridgeReturnResult,
  type BridgeStepCallback,
  type LaunchpadAdapter,
  type PrivateLaunchpadClient,
  type PrivateLaunchpadSession,
} from "@private-launchpad/sdk";

export interface LaunchDraft {
  name: string;
  symbol: string;
  bridgeAmount: bigint;
  creatorReward: number;
}

export interface PreparedIdentity {
  connectedAddress: PrivateLaunchpadSession["account"];
  session: PrivateLaunchpadSession;
}

export interface LaunchpadRuntime {
  readonly mode: "demo" | "live";
  prepareIdentity(): Promise<PreparedIdentity>;
  fund(
    draft: LaunchDraft,
    onStep?: BridgeStepCallback,
  ): Promise<BridgeFundResult>;
  launch(draft: LaunchDraft): Promise<string>;
  returnToPool(onStep?: BridgeStepCallback): Promise<BridgeReturnResult>;
  reset(): void;
}

export interface LiveRuntimeConfig<TOpenIntent, TCloseIntent> {
  appId: string;
  accountIndex: number;
  client: PrivateLaunchpadClient;
  adapter: LaunchpadAdapter<TOpenIntent, TCloseIntent>;
  connectWallet(): Promise<PrivateLaunchpadSession["account"]>;
  signIdentity(args: {
    address: PrivateLaunchpadSession["account"];
    message: string;
  }): Promise<string>;
  buildOpenIntent(
    draft: LaunchDraft,
    session: PrivateLaunchpadSession,
  ): Promise<TOpenIntent> | TOpenIntent;
}

/**
 * Production binding for a host application. Identity material is retained only
 * inside this closure and is never returned to React state, storage, or logs.
 */
export function createLiveRuntime<TOpenIntent, TCloseIntent>(
  config: LiveRuntimeConfig<TOpenIntent, TCloseIntent>,
): LaunchpadRuntime {
  let connectedAddress: PrivateLaunchpadSession["account"] | undefined;
  let identitySignature: string | undefined;
  let session: PrivateLaunchpadSession | undefined;

  const requireIdentity = () => {
    if (!connectedAddress || !identitySignature || !session) {
      throw new Error("prepare the private identity before continuing");
    }
    return { connectedAddress, identitySignature, session };
  };

  return {
    mode: "live",
    async prepareIdentity() {
      connectedAddress = await config.connectWallet();
      identitySignature = await config.signIdentity({
        address: connectedAddress,
        message: createPrivateLaunchpadIdentityMessage(config.appId),
      });
      session = await config.client.deriveSession(
        identitySignature,
        config.accountIndex,
      );
      return { connectedAddress, session };
    },
    async fund(draft, onStep) {
      const identity = requireIdentity();
      return config.client.fundSession({
        signature: identity.identitySignature,
        accountIndex: identity.session.accountIndex,
        amount: draft.bridgeAmount,
        connectedEvmAddress: identity.connectedAddress,
        ...(onStep ? { onStep } : {}),
      });
    },
    async launch(draft) {
      const identity = requireIdentity();
      const intent = await config.buildOpenIntent(draft, identity.session);
      return config.client.open({
        signature: identity.identitySignature,
        session: identity.session,
        adapter: config.adapter,
        intent,
      });
    },
    async returnToPool(onStep) {
      const identity = requireIdentity();
      return config.client.returnSession({
        signature: identity.identitySignature,
        session: identity.session,
        connectedEvmAddress: identity.connectedAddress,
        ...(onStep ? { onStep } : {}),
      });
    },
    reset() {
      connectedAddress = undefined;
      identitySignature = undefined;
      session = undefined;
    },
  };
}

const demoAccount =
  "0x8A4dC8408fB8637A3fD0C0ba8ce95C18B38b5A02" as PrivateLaunchpadSession["account"];
const demoOwner =
  "0x46a8f65f337D2511690A54281017E21b03B0Ab47" as PrivateLaunchpadSession["owner"];
const demoRoot =
  "0x7C26A0F7B7e9DfAA0D21e19b9E5D1D1D8bA84491" as PrivateLaunchpadSession["account"];

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));

async function demoSteps(
  steps: readonly string[],
  onStep?: BridgeStepCallback,
): Promise<void> {
  for (const step of steps) {
    onStep?.(step, "running");
    await pause(420);
    onStep?.(step, "done");
  }
}

export function createDemoRuntime(): LaunchpadRuntime {
  let prepared = false;
  return {
    mode: "demo",
    async prepareIdentity() {
      await pause(520);
      prepared = true;
      return {
        connectedAddress: demoRoot,
        session: {
          accountIndex: 7,
          channel: "private-launchpad-v1",
          owner: demoOwner,
          account: demoAccount,
        },
      };
    },
    async fund(_draft, onStep) {
      if (!prepared) throw new Error("demo identity is not prepared");
      await demoSteps(
        ["select-private-note", "circle-burn", "base-mint"],
        onStep,
      );
      return {
        burnTxHash: sampleHash("burn"),
        accountIndex: 7,
        eoaAddress: demoOwner,
        depositWallet: demoAccount,
        commitmentH: 170141183460469231731687303715884105727n,
        forwardTxHash: sampleHash("forward"),
        channel: "private-launchpad-v1",
      };
    },
    async launch(draft) {
      if (!prepared) throw new Error("demo identity is not prepared");
      await pause(920);
      return sampleHash(`${draft.symbol}-launch`);
    },
    async returnToPool(onStep) {
      if (!prepared) throw new Error("demo identity is not prepared");
      await demoSteps(
        ["base-burn", "circle-attestation", "mint-private-note"],
        onStep,
      );
      return {
        amountReturned: 24_200_000n,
        claimTxHash: sampleHash("claim"),
        ranFreshBurn: true,
        alreadyClaimed: false,
      };
    },
    reset() {
      prepared = false;
    },
  };
}

function sampleHash(seed: string): `0x${string}` {
  let value = 2166136261;
  for (const character of seed) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  const word = (value >>> 0).toString(16).padStart(8, "0");
  return `0x${word.repeat(8)}`;
}
