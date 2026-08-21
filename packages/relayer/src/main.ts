import { relayerFromEnv } from "./relayer.js";
import { startRelayerServer } from "./server.js";

const port = Number(process.env.PORT ?? "8787");
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535)
  throw new Error("invalid PORT");

const relayer = relayerFromEnv(process.env);
startRelayerServer(relayer, port);
