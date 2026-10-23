
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

/**
 * The only method the write path accepts. Narrow on purpose: a write executor
 * that also took DELETE would make "an approved send" mean anything.
 */
const WRITE_METHOD = "POST";

export class ComposioReadOnlyViolationError extends Error {
  readonly code = "composio_read_only_violation";
  constructor(method: string) {
    super(`Composio inline execution refused a ${method} call: only reads may run inside a turn.`);
  }
}

export class ComposioWriteMethodError extends Error {
  readonly code = "composio_write_method";
  constructor(method: string) {
    super(`Composio write execution refused a ${method} call: the write path is POST-only.`);
  }
}

export class ComposioNotConfiguredError extends Error {
  readonly code = "composio_not_configured";
}

/*
 * A hosted-link request that reached Composio and failed. The status is kept
 * on the error because a 401 is a deployment problem (the stored API key is
 * invalid) with a different fix than a provider outage, and the account row
 * should say so instead of rotting into a misleading "expired".
 */
export class ComposioLinkError extends Error {
  readonly code = "composio_link_failed";
  readonly status: number;
  constructor(status: number) {
    // Keep the "failed (N)" phrasing the client test pins; the 401 tail
    // names the cause so the card's lastError says what to fix. The key
    // itself never appears in the message.
    super(
      status === 401
        ? "Composio link request failed (401): the deployment's COMPOSIO_API_KEY is invalid."
        : `Composio link request failed (${status}).`,
    );
    this.status = status;
  }
}

export function authConfigEnvName(provider: string) {
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
    throw new ComposioLinkError(response.status);
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
  // `status` is additive: the gateway tells a revoked credential (401) from a
  // provider outage (500), and reading it back out of `message` would break the
  // first time the wording changed.
  | { ok: false; code: "not_configured" | "read_only_violation" | "provider_error"; message: string; status?: number };

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
 */
/*
 * The one POST through the proxy that every read path shares. The proxy
 * answers `{ data: <provider body> }`; a bare body is accepted too, because
 * the two shipped clients had to handle both shapes. No retry anywhere here:
 * silently retrying a provider call inside a turn hides the failure from the
 * user. The write path keeps its own fetch - its timeout makes a failure
 * `ambiguous`, a deliberately different contract.
 */
async function postThroughProxy(payload: Record<string, unknown>): Promise<ComposioCallResult> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return { ok: false, code: "not_configured", message: "Composio is not configured on this deployment yet." };
  let response: Response;
  try {
    response = await fetch(EXECUTE_PROXY_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, code: "provider_error", message: "The connected service is unreachable." };
  }
  if (!response.ok) {
    return { ok: false, code: "provider_error", status: response.status, message: `The connected service returned ${response.status}.` };
  }
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (body === null) return { ok: false, code: "provider_error", message: "The connected service returned no body." };
  return { ok: true, data: "data" in body ? body.data : body };
}

export async function executeComposioRead(call: ComposioCall): Promise<ComposioCallResult> {
  if (!READ_METHODS.has(call.method)) throw new ComposioReadOnlyViolationError(call.method);
  const parameters = Object.entries(call.headers ?? {}).map(([name, value]) => ({ name, value, type: "header" }));
  for (const [name, value] of Object.entries(call.query ?? {})) {
    parameters.push({ name, value, type: "query" });
  }
  return postThroughProxy({
    connected_account_id: call.connectedAccountId,
    endpoint: call.endpoint,
    method: call.method,
    ...(call.body === undefined ? {} : { body: call.body }),
    parameters,
  });
}

/*
 * GraphQL is POST on the wire, so the read-only method guard cannot admit it.
 * This path instead refuses anything that is not a single query document, and
 * the endpoint is fixed by the caller's module, never by a model. A document
 * naming a mutation or subscription is refused before any request is built.
 */
const GRAPHQL_FORBIDDEN = /\b(mutation|subscription)\b/i;

export class ComposioGraphqlNotQueryError extends Error {
  readonly code = "composio_graphql_not_query";
  constructor() {
    super("Composio inline GraphQL refused a document that is not a plain query.");
  }
}

export async function executeComposioGraphqlRead(call: {
  connectedAccountId: string;
  endpoint: string;
  query: string;
  variables?: Record<string, unknown>;
}): Promise<ComposioCallResult> {
  if (!/^\s*query\b/.test(call.query) || GRAPHQL_FORBIDDEN.test(call.query)) throw new ComposioGraphqlNotQueryError();
  return postThroughProxy({
    connected_account_id: call.connectedAccountId,
    endpoint: call.endpoint,
    method: "POST",
    body: { query: call.query, variables: call.variables ?? {} },
    parameters: [],
  });
}

/*
 * A constant-body POST read (Notion search). Same seam discipline as the
 * GraphQL read: the provider module fixes the endpoint and the body shape,
 * caller-supplied values travel inside the body only after validation, and
 * the proxy still answers `{ data: <provider body> }`. There is no method
 * parameter - a POST read cannot become anything else from here.
 */
export async function executeComposioPostRead(call: {
  connectedAccountId: string;
  endpoint: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<ComposioCallResult> {
  const parameters = Object.entries(call.headers ?? {}).map(([name, value]) => ({ name, value, type: "header" }));
  return postThroughProxy({
    connected_account_id: call.connectedAccountId,
    endpoint: call.endpoint,
    method: "POST",
    body: call.body,
    parameters,
  });
}

/** A write call: the method is fixed at the type level, and guarded at runtime. */
export type ComposioWriteCall = Omit<ComposioCall, "method"> & { method: "POST" };

export type ComposioWriteResult =
  | { ok: true; data: unknown }
  // `ambiguous` is the important one: the request may have reached the provider.
  // Anything that cannot prove "not sent" belongs here, and the executor turns
  // it into UNKNOWN rather than a retry.
  | { ok: false; code: "not_configured" | "provider_error" | "ambiguous"; message: string; status?: number };

/**
 * Runs one write through Composio. Reachable only from the approved-effect
 * executor — nothing in a turn can call it, and nothing should: a model that
 * could reach this would be a model that can send mail without review.
 *
 * POST only. The read path refuses writes; this refuses everything that is not
 * a write, so neither path can quietly widen into the other.
 *
 * The timeout exists to bound the executor's request, not to make the send
 * safe: a timeout is `ambiguous`, because the provider may have accepted the
 * request before the socket died.
 */
const WRITE_TIMEOUT_MS = 30_000;

export async function executeComposioWrite(call: ComposioWriteCall): Promise<ComposioWriteResult> {
  if (call.method !== WRITE_METHOD) throw new ComposioWriteMethodError(String(call.method));
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return { ok: false, code: "not_configured", message: "Composio is not configured on this deployment yet." };
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
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      body: JSON.stringify({
        connected_account_id: call.connectedAccountId,
        endpoint: call.endpoint,
        method: call.method,
        ...(call.body === undefined ? {} : { body: call.body }),
        parameters,
      }),
    });
  } catch {
    return { ok: false, code: "ambiguous", message: "The connected service did not answer; the outcome is unknown." };
  }
  if (!response.ok) {
    const status = response.status;
    // A 5xx may mean the provider accepted the request and failed afterwards.
    // Only a 4xx proves the call was refused before it took effect.
    return status >= 400 && status < 500
      ? { ok: false, code: "provider_error", status, message: `The connected service rejected the call (${status}).` }
      : { ok: false, code: "ambiguous", status, message: `The connected service returned ${status}.` };
  }
  // A 2xx whose body cannot be parsed is still a success at the provider with
  // no id we can record, which the caller cannot distinguish from a lost
  // response. Say so rather than inventing an outcome.
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (body === null) {
    return { ok: false, code: "ambiguous", status: response.status, message: "The connected service returned no parseable body." };
  }
  return { ok: true, data: "data" in body ? body.data : body };
}
