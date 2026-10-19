
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
