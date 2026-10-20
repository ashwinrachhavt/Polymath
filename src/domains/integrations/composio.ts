
/*
 * The only module that talks to Composio (D09). It reads two kinds of env:
 * COMPOSIO_API_KEY (the project key; the token never leaves Composio) and
 * COMPOSIO_AUTH_CONFIG_<PROVIDER> per provider (the owner creates auth
 * configs in the Composio dashboard; ids are deployment config, not secrets
 * we can invent). Without them the connect flow reports "not configured"
 * instead of failing sideways. API: POST /api/v3.1/connected_accounts/link
 * (docs.composio.dev connected-accounts reference).
 */

const API_BASE = "https://backend.composio.dev/api/v3.1";
/**
 * The v3 tool-execution surface. The v3.1 base above serves connect links; the
 * proxy endpoint that carries a plain HTTP call through a connected account is
 * still on v3 (verified in src/integrations/notion/client.ts and
 * src/integrations/google-calendar/client.ts, 2026-10-18).
 */
const EXECUTE_PROXY_URL = "https://backend.composio.dev/api/v3/tools/execute/proxy";

/**
 * Methods a *read* capability may use. Anything that could change state on the
 * provider is refused here rather than trusted to a tool author: the policy
 * layer decides whether a capability is allowed at all, and this decides whether
 * it is safe to run inline. Writes go through action proposals, never this path.
 */
const READ_METHODS = new Set(["GET", "HEAD"]);

export class ComposioReadOnlyViolationError extends Error {
  readonly code = "composio_read_only_violation";
  constructor(method: string) {
    super(`Composio inline execution refused a ${method} call: only reads may run inside a turn.`);
  }
}

export class ComposioNotConfiguredError extends Error {
  readonly code = "composio_not_configured";
}

function authConfigEnvName(provider: string) {
  return `COMPOSIO_AUTH_CONFIG_${provider.toUpperCase().replace(/-/g, "_")}`;
}

export function isComposioConfigured(provider: string): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY && process.env[authConfigEnvName(provider)]);
}

/** Creates the hosted-auth link session. Throws ComposioNotConfiguredError when env is missing. */
export async function createHostedConnectLink(input: {
  provider: string;
  userId: string;
  alias: string;
  callbackUrl: string;
}): Promise<{ redirectUrl: string; connectedAccountId: string; expiresAt: string }> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  const authConfigId = process.env[authConfigEnvName(input.provider)];
  if (!apiKey || !authConfigId) {
    throw new ComposioNotConfiguredError(
      `Composio is not configured for "${input.provider}" on this deployment yet.`,
    );
  }
  const response = await fetch(`${API_BASE}/connected_accounts/link`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      auth_config_id: authConfigId,
      user_id: input.userId,
      alias: input.alias,
      callback_url: input.callbackUrl,
    }),
  });
  if (!response.ok) {
    throw new Error(`Composio link request failed (${response.status}).`);
  }
  const body = (await response.json()) as { redirect_url: string; connected_account_id: string; expires_at: string };
  return { redirectUrl: body.redirect_url, connectedAccountId: body.connected_account_id, expiresAt: body.expires_at };
}

/** Callback-side verification: the account Composio says it connected. */
export async function getConnectedAccount(connectedAccountId: string): Promise<{
  id: string;
  status: string;
}> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new ComposioNotConfiguredError("Composio is not configured on this deployment yet.");
  }
  const response = await fetch(`${API_BASE}/connected_accounts/${encodeURIComponent(connectedAccountId)}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    throw new Error(`Composio account lookup failed (${response.status}).`);
  }
  const body = (await response.json()) as { id: string; status: string };
  return { id: body.id, status: body.status };
}

/** One provider call routed through a connected account. The token stays with Composio. */
export type ComposioCall = {
  connectedAccountId: string;
  endpoint: string;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
};

export type ComposioCallResult =
  | { ok: true; data: unknown }
  | { ok: false; code: "not_configured" | "read_only_violation" | "provider_error"; message: string };

/**
 * Runs one read against a provider through Composio and returns its parsed body.
 *
 * This is the inline-execution seam for agent tools. It is deliberately narrow:
 *  - reads only. A write-shaped method throws `ComposioReadOnlyViolationError`
 *    rather than returning an error object, because reaching it is a programming
 *    error in the tool, not a condition a model should see and retry.
 *  - no retry. A read is safe to retry at the caller, but silently retrying a
 *    provider call inside a turn hides the failure from the user.
 *  - the caller has already checked the run's policy snapshot; this function
 *    cannot see a policy and must not be the only gate.
 *
 * The proxy answers `{ data: <provider body> }`; a bare body is accepted too,
 * because the two shipped clients had to handle both shapes.
 */
export async function executeComposioRead(call: ComposioCall): Promise<ComposioCallResult> {
  if (!READ_METHODS.has(call.method)) throw new ComposioReadOnlyViolationError(call.method);
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      code: "not_configured",
      message: "Composio is not configured on this deployment yet.",
    };
  }
  const parameters = Object.entries(call.headers ?? {}).map(([name, value]) => ({ name, value, type: "header" }));
  for (const [name, value] of Object.entries(call.query ?? {})) {
    parameters.push({ name, value, type: "query" });
  }
  let response: Response;
  try {
    response = await fetch(EXECUTE_PROXY_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        connected_account_id: call.connectedAccountId,
        endpoint: call.endpoint,
        method: call.method,
        ...(call.body === undefined ? {} : { body: call.body }),
        parameters,
      }),
    });
  } catch {
    return { ok: false, code: "provider_error", message: "The connected service is unreachable." };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: "provider_error",
      message: `The connected service returned ${response.status}.`,
    };
  }
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (body === null) return { ok: false, code: "provider_error", message: "The connected service returned no body." };
  return { ok: true, data: "data" in body ? body.data : body };
}
