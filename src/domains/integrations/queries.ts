import { and, asc, eq } from "drizzle-orm";
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
  accounts: Array<{
    id: string;
    alias: string;
    status: string;
    displayName: string | null;
    isDefaultForWrites: boolean;
    lastHealthyAt: Date | null;
    lastError: string | null;
    version: number;
  }>;
};

export async function listConnectors(auth: AuthContext): Promise<ConnectorCard[]> {
  const [catalog, accounts] = await Promise.all([
    db.select().from(integrationCatalog).orderBy(asc(integrationCatalog.provider)),
    db
      .select()
      .from(externalAccounts)
      .where(eq(externalAccounts.workspaceId, auth.workspaceId))
      .orderBy(asc(externalAccounts.provider), asc(externalAccounts.alias)),
  ]);
  return catalog.map((row) => ({
    provider: row.provider,
    displayName: row.displayName,
    capabilities: row.capabilities as string[],
    riskByCapability: row.riskByCapability as Record<string, string>,
    requiresApproval: row.requiresApproval,
    accounts: accounts
      .filter((account) => account.provider === row.provider)
      .map((account) => ({
        id: account.id,
        alias: account.alias,
        status: account.status,
        displayName: account.displayName,
        isDefaultForWrites: account.isDefaultForWrites,
        lastHealthyAt: account.lastHealthyAt,
        lastError: account.lastError,
        version: account.version,
      })),
  }));
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
 * The connected account an agent tool should read through.
 *
 * `alias` is what the owner names an account and what a model is allowed to
 * choose; the Composio id never appears in a tool argument. An explicit alias
 * must exist, be connected, and have a Composio id — a merely "connecting"
 * account is not a usable credential. Without an alias, only a single healthy
 * account for that provider is inferred; two accounts with no alias is an
 * ambiguity the tool must surface, not guess at.
 */
export async function resolveConnectedAccount(
  auth: AuthContext,
  provider: string,
  alias?: string,
): Promise<
  | { ok: true; connectedAccountId: string; alias: string }
  | { ok: false; code: "not_connected" | "ambiguous"; message: string }
> {
  const rows = await db
    .select({
      alias: externalAccounts.alias,
      status: externalAccounts.status,
      connectedAccountId: externalAccounts.composioConnectedAccountId,
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

  const usable = rows.filter((row) => typeof row.connectedAccountId === "string" && row.connectedAccountId.length > 0);
  if (alias) {
    const match = usable.find((row) => row.alias === alias);
    return match && match.connectedAccountId
      ? { ok: true, connectedAccountId: match.connectedAccountId, alias: match.alias }
      : { ok: false, code: "not_connected", message: `No connected ${provider} account named "${alias}".` };
  }
  if (usable.length === 1 && usable[0].connectedAccountId) {
    return { ok: true, connectedAccountId: usable[0].connectedAccountId, alias: usable[0].alias };
  }
  if (usable.length === 0) {
    return { ok: false, code: "not_connected", message: `No ${provider} account is connected.` };
  }
  return {
    ok: false,
    code: "ambiguous",
    message: `More than one ${provider} account is connected (${usable.map((r) => r.alias).join(", ")}); name one.`,
  };
}
