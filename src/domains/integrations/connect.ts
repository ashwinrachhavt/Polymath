import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { connectionAttempts, externalAccounts } from "./schema";

/*
 * D09 OAuth scaffolding (ASH-160). beginConnection creates the hosted-auth
 * attempt: it (re)uses the account row in `connecting`, mints the state
 * token, and stores the attempt. The caller - the route handler - then asks
 * Composio for the hosted link and stores it on the attempt via
 * attachProviderLink; the browser only ever sees the state token and the
 * hosted URL. completeConnection is the callback side: the token resolves
 * the attempt, and the account goes active with the connected-account id.
 * Neither function calls the provider itself, so both are fully testable
 * without credentials; the Composio client lives in composio.ts.
 */

export class ConflictError extends Error {
  readonly code = "conflict";
}

export class StaleWriteError extends Error {
  readonly code = "stale_write";
}

const ATTEMPT_TTL_MS = 15 * 60 * 1000;

export async function beginConnection(
  auth: AuthContext,
  input: { provider: string; alias: string; displayName?: string },
) {
  return withTransaction(async (tx) => {
    let [account] = await tx
      .select()
      .from(externalAccounts)
      .where(
        and(
          eq(externalAccounts.workspaceId, auth.workspaceId),
          eq(externalAccounts.provider, input.provider),
          eq(externalAccounts.alias, input.alias),
        ),
      )
      .limit(1);
    if (!account) {
      [account] = await tx
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
    }
    if (account.status === "revoked") {
      throw new ConflictError(`"${input.alias}" was revoked. Register a new alias instead.`);
    }

    const stateToken = crypto.randomUUID();
    const [attempt] = await tx
      .insert(connectionAttempts)
      .values({
        workspaceId: auth.workspaceId,
        externalAccountId: account.id,
        provider: input.provider,
        stateToken,
        expiresAt: new Date(Date.now() + ATTEMPT_TTL_MS),
        createdBy: auth.userId,
      })
      .returning();
    await recordAudit(
      auth,
      { action: "integration.connection_started", subjectType: "external_account", subjectId: account.id, summary: `Connection started: ${input.provider} as "${input.alias}"` },
      tx,
    );
    return { account, attempt };
  });
}

/** The route handler stores the hosted link Composio returned. */
export async function attachProviderLink(auth: AuthContext, input: { attemptId: string; redirectUrl: string }) {
  return withTransaction(async (tx) => {
    const [updated] = await tx
      .update(connectionAttempts)
      .set({ providerRedirectUrl: input.redirectUrl })
      .where(
        and(
          eq(connectionAttempts.workspaceId, auth.workspaceId),
          eq(connectionAttempts.id, input.attemptId),
          eq(connectionAttempts.status, "pending"),
        ),
      )
      .returning();
    if (!updated) throw new StaleWriteError("That connection attempt is no longer pending.");
    return updated;
  });
}

/**
 * Callback side. Resolves the attempt by state token (the only browser-held
 * value), then completes it and flips the account active with the provider's
 * connected-account id - all in one transaction with the audit row. The
 * Composio verification call happens in the route before this runs.
 */
export async function completeConnection(
  auth: AuthContext,
  input: { stateToken: string; providerConnectedAccountId: string; scopesSummary?: string[] },
) {
  return withTransaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(connectionAttempts)
      .where(
        and(eq(connectionAttempts.workspaceId, auth.workspaceId), eq(connectionAttempts.stateToken, input.stateToken)),
      )
      .limit(1);
    if (!attempt) throw new ConflictError("Unknown connection attempt. Start the connection again.");
    if (attempt.status === "completed") return { attempt, alreadyCompleted: true };
    if (attempt.status !== "pending") throw new ConflictError(`That connection attempt already ${attempt.status}. Start again.`);
    if (attempt.expiresAt.getTime() < Date.now()) {
      await tx
        .update(connectionAttempts)
        .set({ status: "expired", completedAt: new Date() })
        .where(eq(connectionAttempts.id, attempt.id));
      throw new ConflictError("That connection attempt expired. Start again.");
    }

    const [completed] = await tx
      .update(connectionAttempts)
      .set({ status: "completed", providerConnectedAccountId: input.providerConnectedAccountId, completedAt: new Date() })
      .where(and(eq(connectionAttempts.id, attempt.id), eq(connectionAttempts.status, "pending")))
      .returning();
    if (!completed) throw new StaleWriteError("The connection attempt changed. Start again.");

    const [account] = await tx
      .update(externalAccounts)
      .set({
        status: "active",
        composioConnectedAccountId: input.providerConnectedAccountId,
        ...(input.scopesSummary ? { scopesSummary: input.scopesSummary } : {}),
        lastHealthyAt: new Date(),
        lastError: null,
        version: sql`${externalAccounts.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      })
      .where(and(eq(externalAccounts.id, attempt.externalAccountId), eq(externalAccounts.workspaceId, auth.workspaceId)))
      .returning();
    await recordAudit(
      auth,
      { action: "integration.connection_completed", subjectType: "external_account", subjectId: account.id, summary: `Connected: ${attempt.provider} as "${account.alias}"` },
      tx,
    );
    return { attempt: completed, account, alreadyCompleted: false };
  });
}
