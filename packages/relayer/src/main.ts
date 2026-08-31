import { relayerFromEnv } from "./relayer.js";
import { startRelayerServer } from "./server.js";
import { clankerQuoteServiceFromEnv } from "./clanker-quotes.js";

const port = Number(process.env.PORT ?? "8787");
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535)
  throw new Error("invalid PORT");

const relayer = relayerFromEnv(process.env);
const quoteService = clankerQuoteServiceFromEnv(
  process.env,
  relayer.policy.chainId,
  relayer.dependencies.publicClient,
);
startRelayerServer(relayer, port, {
  ...(quoteService ? { quoteService } : {}),
});
