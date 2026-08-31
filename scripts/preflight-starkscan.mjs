const apiKey = process.env.STARKSCAN_API_KEY;
if (!apiKey) fail("STARKSCAN_API_KEY is required");

const endpoint = proverEndpoint(
  process.env.STARKSCAN_PROVER_URL ??
    "https://api.starkscan.co/v1/SN_MAIN/prove",
);
const headers = {
  accept: "application/json",
  "x-starkscan-api-key": apiKey,
};

try {
  const capabilitiesResponse = await fetch(
    new URL("/v1/meta/capabilities", endpoint),
    {
      headers,
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(30_000),
    },
  );
  const capabilities = await responseObject(
    capabilitiesResponse,
    "Starkscan capabilities",
  );
  if (!capabilitiesResponse.ok) {
    throw new Error(
      `Starkscan API key authentication failed (${capabilitiesResponse.status})`,
    );
  }
  const caller = record(capabilities.caller, "Starkscan caller capabilities");
  const scopes = Array.isArray(caller.scopes) ? caller.scopes : [];
  if (!scopes.every((scope) => typeof scope === "string")) {
    throw new Error("Starkscan returned invalid caller scopes");
  }
  if (!scopes.includes("prove")) {
    throw new Error(
      "Starkscan API key is authenticated but prove scope is missing",
    );
  }

  // Omitting Idempotency-Key is rejected before Starkscan can create a proof
  // job. This checks route enablement without consuming proving quota.
  const routeResponse = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(30_000),
  });
  if (routeResponse.status !== 400) {
    throw new Error(
      `Starkscan mainnet proving route returned ${routeResponse.status}; expected the safe preflight rejection (400)`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        authenticated: true,
        proveScope: true,
        relayRouteEnabled: true,
        endpoint: endpoint.href,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : "unknown preflight error");
}

function proverEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    fail("STARKSCAN_PROVER_URL must be a valid URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password
  ) {
    fail("STARKSCAN_PROVER_URL must be credential-free HTTPS");
  }
  return endpoint;
}

async function responseObject(response, field) {
  try {
    return record(await response.json(), field);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("must be an object")) {
      throw error;
    }
    throw new Error(`${field} returned invalid JSON`);
  }
}

function record(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function fail(message) {
  process.stderr.write(`Starkscan prover preflight failed: ${message}\n`);
  process.exit(1);
}
