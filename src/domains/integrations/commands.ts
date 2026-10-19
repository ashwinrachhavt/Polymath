import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { externalAccounts, integrationCatalog } from "./schema";

/*
 * Connector account bookkeeping (ASH D09 foundation). These commands manage
 * Polymath's own rows: registering an account alias, recording the state of an
 * OAuth flow, choosing the explicit write default, revoking. They never call
 * the provider - the token stays with Composio, and the connect flow
 * scaffolding hands the browser a link without writing anything upstream.
 */

export class ConflictError extends Error {
  readonly code = "conflict";
}

export class StaleWriteError extends Error {
  readonly code = "stale_write";
}

export async function registerAccount(
  auth: AuthContext,
  input: { provider: string; alias: string; displayName?: string },
) {
  return withTransaction(async (tx) => {
    const [catalogRow] = await tx
      .select({ provider: integrationCatalog.provider })
      .from(integrationCatalog)
      .where(eq(integrationCatalog.provider, input.provider))
      .limit(1);
    if (!catalogRow) throw new ConflictError(`"${input.provider}" is not in the connector catalog.`);

    try {
      const [account] = await tx
        .insert(externalAccounts)
        .values({
          workspaceId: auth.workspaceId,
          provider: input.provider,
          alias: input.alias,
          displayName: input.displayName ?? null,
          status: "connecting",
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(
        auth,
        { action: "integration.account_registered", subjectType: "external_account", subjectId: account.id, summary: `Connector registered: ${input.provider} as "${input.alias}"` },
        tx,
      );
      return account;
    } catch (cause) {
      if ((cause as { cause?: { code?: string } })?.cause?.code === "23505") {
        throw new ConflictError(`The alias "${input.alias}" is already used for another account.`);
      }
      throw cause;
    }
  });
}

/** OAuth scaffolding bookkeeping: the flow succeeded, expired, errored, or was revoked. */
export async function setAccountStatus(
  auth: AuthContext,
  input: {
    accountId: string;
    expectedVersion: number;
    status: "active" | "expired" | "revoked" | "error";
    lastError?: string | null;
    composioConnectedAccountId?: string;
  },
) {
  return withTransaction(async (tx) => {
    const [updated] = await tx
      .update(externalAccounts)
      .set({
        status: input.status,
        lastError: input.lastError ?? null,
        ...(input.status === "active" ? { lastHealthyAt: new Date() } : {}),
        ...(input.composioConnectedAccountId ? { composioConnectedAccountId: input.composioConnectedAccountId } : {}),
        version: sql`${externalAccounts.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      })
      .where(
        and(
          eq(externalAccounts.workspaceId, auth.workspaceId),
          eq(externalAccounts.id, input.accountId),
          eq(externalAccounts.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new StaleWriteError("The connector account changed since you loaded it. Reload and try again.");
    }
    await recordAudit(
      auth,
      { action: `integration.account_${input.status}`, subjectType: "external_account", subjectId: updated.id, summary: `Connector ${updated.alias}: ${input.status}` },
      tx,
    );
    return updated;
  });
}

/**
 * The write default is explicit and singular per provider: choosing one
 * account clears the flag on the provider's other accounts in the same
 * transaction. Models choose aliases, never ids, and nothing writes by
 * default until this is set.
 */
export async function setDefaultForWrites(
  auth: AuthContext,
  input: { accountId: string; expectedVersion: number },
) {
  return withTransaction(async (tx) => {
    const [target] = await tx
      .update(externalAccounts)
      .set({ isDefaultForWrites: true, version: sql`${externalAccounts.version} + 1`, updatedAt: new Date(), updatedBy: auth.userId })
      .where(
        and(
          eq(externalAccounts.workspaceId, auth.workspaceId),
          eq(externalAccounts.id, input.accountId),
          eq(externalAccounts.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!target) {
      throw new StaleWriteError("The connector account changed since you loaded it. Reload and try again.");
    }
    await tx
      .update(externalAccounts)
      .set({ isDefaultForWrites: false, version: sql`${externalAccounts.version} + 1`, updatedAt: new Date(), updatedBy: auth.userId })
      .where(
        and(
          eq(externalAccounts.workspaceId, auth.workspaceId),
          eq(externalAccounts.provider, target.provider),
          sql`${externalAccounts.id} <> ${target.id}`,
        ),
      );
    await recordAudit(
      auth,
      { action: "integration.write_default_set", subjectType: "external_account", subjectId: target.id, summary: `Write default for ${target.provider}: "${target.alias}"` },
      tx,
    );
    return target;
  });
}
