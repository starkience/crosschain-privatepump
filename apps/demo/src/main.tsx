import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { App } from "./App.js";
import { PONS_BROWSER_CONFIG } from "./browser-config.js";
import "./styles.css";
import "./mobile.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

try {
  const runtime = await import("./pons-live.js").then((module) =>
    module.createPrivatePonsLiveRuntime(PONS_BROWSER_CONFIG),
  );
  root.render(
    <React.StrictMode>
      <App runtime={runtime} />
    </React.StrictMode>,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "Runtime failed";
  root.render(
    <main className="startup-error">
      <p>PRIVATEPONS / SETUP</p>
      <h1>Live mode is not ready.</h1>
      <span>{message}</span>
      <small>Check the private server routes and try again.</small>
    </main>,
  );
}
