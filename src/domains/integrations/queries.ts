import { and, asc, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { externalAccounts, integrationCatalog, syncCursors } from "./schema";

/*
 * Connector reads (ASH D09 foundation). The catalog is global (seeded by
 * migration); accounts and cursors are workspace rows. No provider is ever
 * called from here - these rows are Polymath's own bookkeeping.
 */

export type ConnectorCard = {
  provider: string;
  displayName: string;
  capabilities: string[];
  riskByCapability: Record<string, string>;
  requiresApproval: boolean;
  accessTiers: Array<{ id: string; label: string; description: string; capabilities: string[] }>;
  /** False when this deployment lacks the env the OAuth flow needs; the card says so instead of offering a doomed Connect. */
  configured: boolean;
  /** The env vars an operator must set before this provider can connect. */
  missingConfig: string[];
  accounts: Array<{
    id: string;
    alias: string;
    status: string;
    displayName: string | null;
    isDefaultForWrites: boolean;
    allowRead: boolean;
    allowWrite: boolean;
    accessTier: string | null;
    disabledCapabilities: string[];
    lastHealthyAt: Date | null;
    lastError: string | null;
    version: number;
  }>;
};

/**
 * Whether this deployment can connect providers at all. The Composio project
 * key is the only deployment env the connect flow needs — auth config ids
 * resolve from the Composio API at link time, so per-provider
 * COMPOSIO_AUTH_CONFIG_<PROVIDER> vars are never demanded here.
 * Extracted pure for the card tests.
 */
export function connectorConfigState(env: {
  composioApiKey?: string;
  providerEnv: Record<string, string | undefined>;
}): { configured: boolean; missingConfig: string[] } {
  const missingConfig = env.composioApiKey ? [] : ["COMPOSIO_API_KEY"];
  return { configured: missingConfig.length === 0, missingConfig };
}

export async function listConnectors(auth: AuthContext): Promise<ConnectorCard[]> {
  // A connection attempt the owner never finished would leave its account in
  // `connecting` forever — a card that says Connecting on every visit. The
  // read sweeps the workspace's expired attempts so the card tells the truth
  // the moment the owner looks at it.
  await db.execute(sql`
    with expired as (
      update connection_attempts
      set status = 'expired', completed_at = now()
      where workspace_id = ${auth.workspaceId} and status = 'pending' and expires_at < now()
      returning external_account_id
    )
    update external_accounts a
    set last_error = 'That connection attempt expired. Start again.', updated_at = now()
    from expired
    where a.id = expired.external_account_id and a.status = 'connecting'
  `);

  const [catalog, accounts] = await Promise.all([
    db.select().from(integrationCatalog).orderBy(asc(integrationCatalog.provider)),
    db
      .select()
      .from(externalAccounts)
      .where(eq(externalAccounts.workspaceId, auth.workspaceId))
      .orderBy(asc(externalAccounts.provider), asc(externalAccounts.alias)),
  ]);
  // The connect flow needs one piece of deployment env: the Composio project
  // key. Auth config ids are discovered from the Composio API with that key
  // (see composio.ts), so a missing COMPOSIO_AUTH_CONFIG_<PROVIDER> var is
  // not a broken deployment — naming it on the card would make every
  // provider on a working deployment read as "Setup needed".
  return catalog.map((row) => {
    const { configured, missingConfig } = connectorConfigState({
      composioApiKey: process.env.COMPOSIO_API_KEY,
      providerEnv: {},
    });
    return {
    provider: row.provider,
    displayName: row.displayName,
    capabilities: row.capabilities as string[],
    riskByCapability: row.riskByCapability as Record<string, string>,
    requiresApproval: row.requiresApproval,
    accessTiers: row.accessTiers as Array<{ id: string; label: string; description: string; capabilities: string[] }>,
    configured: missingConfig.length === 0,
    missingConfig,
    accounts: accounts
      .filter((account) => account.provider === row.provider)
      .map((account) => ({
        id: account.id,
        alias: account.alias,
        status: account.status,
        displayName: account.displayName,
        isDefaultForWrites: account.isDefaultForWrites,
        allowRead: account.allowRead,
        allowWrite: account.allowWrite,
        accessTier: account.accessTier,
        disabledCapabilities: (account.disabledCapabilities as string[]) ?? [],
        lastHealthyAt: account.lastHealthyAt,
        lastError: account.lastError,
        version: account.version,
      })),
    };
  });
}

export async function listSyncCursors(auth: AuthContext, accountId: string) {
  return db
    .select()
    .from(syncCursors)
    .where(and(eq(syncCursors.workspaceId, auth.workspaceId), eq(syncCursors.externalAccountId, accountId)))
    .orderBy(asc(syncCursors.resource))
    .limit(50);
}

/**
 * The connected account an agent tool should act through.
 *
 * `alias` is what the owner names an account and what a model is allowed to
 * choose; the Composio id never appears in a tool argument. An explicit alias
 * must exist, be connected, and have a Composio id — a merely "connecting"
 * account is not a usable credential. Without an alias, only a single healthy
 * account for that provider is inferred; two accounts with no alias is an
 * ambiguity the tool must surface, not guess at.
 *
 * The account's `accessTier` rides on the success result so the gateway can
 * gate capabilities against it without a second query. Unset reads as
 * "read_only": the narrowest offer, never "everything".
 */
export async function resolveConnectedAccount(
  auth: AuthContext,
  provider: string,
  alias?: string,
  /**
   * ASH-289: when a sending grant names authorized aliases, resolution happens
   * inside that list only - an unnamed sender never falls back to a connected
   * account the grant does not cover.
   */
  restrictToAliases?: string[],
): Promise<
  | {
      ok: true;
      connectedAccountId: string;
      alias: string;
      accessTier: string;
      disabledCapabilities: string[];
      /** The external_accounts row behind the alias, for approval pinning. */
      externalAccountId: string;
      /** The owner's registered label for the account, when set. */
      displayName: string | null;
    }
  | { ok: false; code: "not_connected" | "ambiguous"; message: string }
> {
  const rows = await db
    .select({
      id: externalAccounts.id,
      alias: externalAccounts.alias,
      status: externalAccounts.status,
      connectedAccountId: externalAccounts.composioConnectedAccountId,
      accessTier: externalAccounts.accessTier,
      disabledCapabilities: externalAccounts.disabledCapabilities,
      displayName: externalAccounts.displayName,
    })
    .from(externalAccounts)
    .where(
      and(
        eq(externalAccounts.workspaceId, auth.workspaceId),
        eq(externalAccounts.provider, provider),
        eq(externalAccounts.status, "active"),
      ),
    )
    .orderBy(asc(externalAccounts.alias))
    .limit(25);

  const connected = rows.filter((row) => typeof row.connectedAccountId === "string" && row.connectedAccountId.length > 0);
  // undefined = no grant policy (unrestricted); [] = a grant saved empty,
  // which blocks every sender - an empty list must NOT fall back to all
  // connected accounts.
  const usable = restrictToAliases === undefined ? connected : connected.filter((row) => restrictToAliases.includes(row.alias));

  let match: (typeof usable)[number] | undefined;
  if (alias) {
    match = usable.find((row) => row.alias === alias);
    if (!match) {
      return { ok: false, code: "not_connected", message: `No connected ${provider} account named "${alias}".` };
    }
  } else if (usable.length === 0) {
    return {
      ok: false,
      code: "not_connected",
      message:
        restrictToAliases === undefined
          ? `No ${provider} account is connected.`
          : restrictToAliases.length > 0
            ? `None of the authorized ${provider} senders (${restrictToAliases.join(", ")}) is connected.`
            : `Sending is blocked: the ${provider} sending grant authorizes no senders.`,
    };
  } else if (usable.length > 1) {
    return {
      ok: false,
      code: "ambiguous",
      message: `More than one ${provider} account is connected (${usable.map((r) => r.alias).join(", ")}); name one.`,
    };
  } else {
    match = usable[0];
  }

  if (!match.connectedAccountId) {
    return { ok: false, code: "not_connected", message: `No ${provider} account is connected.` };
  }

  return {
    ok: true,
    connectedAccountId: match.connectedAccountId,
    alias: match.alias,
    externalAccountId: match.id,
    displayName: match.displayName ?? null,
    accessTier: match.accessTier ?? "read_only",
    disabledCapabilities: (match.disabledCapabilities as string[]) ?? [],
  };
}
