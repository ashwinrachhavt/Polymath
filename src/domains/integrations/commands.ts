import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { PROVIDER_TIERS, type Provider } from "./capabilities";
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

    // Aliases are unique per workspace across providers (agents choose
    // accounts by alias); a same-provider re-register is the resume path.
    const [aliased] = await tx
      .select({ provider: externalAccounts.provider })
      .from(externalAccounts)
      .where(and(eq(externalAccounts.workspaceId, auth.workspaceId), eq(externalAccounts.alias, input.alias)))
      .limit(1);
    if (aliased && aliased.provider !== input.provider) {
      throw new ConflictError(
        `"${input.alias}" is already the name of your ${aliased.provider} account. Pick another name.`,
      );
    }

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
 * What an account may do. Write means "may file a proposal", never "may send",
 * so these flags narrow the effect of a connection without granting an effect
 * of their own. Both flags move together under one version check because they
 * are read as a pair by the gateway; two separate writes could leave the
 * account in a state nobody chose.
 */
export async function setAccountAccessTier(
  auth: AuthContext,
  input: { accountId: string; expectedVersion: number; tierId: string },
) {
  return withTransaction(async (tx) => {
    const [account] = await tx
      .select({ id: externalAccounts.id, provider: externalAccounts.provider })
      .from(externalAccounts)
      .where(and(eq(externalAccounts.workspaceId, auth.workspaceId), eq(externalAccounts.id, input.accountId)))
      .limit(1);
    if (!account) {
      throw new StaleWriteError("The connector account changed since you loaded it. Reload and try again.");
    }
    const tier = PROVIDER_TIERS[account.provider as Provider]?.find((t) => t.id === input.tierId);
    if (!tier) {
      throw new ConflictError(`"${input.tierId}" is not an access tier this connection offers.`);
    }
    const [updated] = await tx
      .update(externalAccounts)
      .set({
        accessTier: tier.id,
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
      {
        action: "integration.account_tier_set",
        subjectType: "external_account",
        subjectId: updated.id,
        summary: `Connector ${updated.alias}: agent access set to ${tier.label}`,
        metadata: { tierId: tier.id },
      },
      tx,
    );
    return updated;
  });
}

/**
 * Revoking is the owner's stop button: the row stays (history, audit, and the
 * alias keep pointing at something real), but every read and every send looks
 * up `status = 'active'` live, so a revoked account stops being usable the
 * moment this commits. The provider connection is deliberately left alone -
 * this slice stops Polymath from using it, not the provider from holding it.
 *
 * Idempotent on purpose: revoking an already-revoked row is a no-op success,
 * not a stale-version error, so a double click or a retried action does not
 * read as a failure. Any other status change still requires the version the
 * caller loaded.
 */
export async function revokeConnectedAccount(
  auth: AuthContext,
  input: { accountId: string; expectedVersion: number },
) {
  // Read first, write second. The read is not in the write's transaction on
  // purpose: the version predicate in `setAccountStatus` is what makes the
  // write safe, and a read-only precheck inside a second transaction would
  // nest one transaction in another for no gain.
  const [account] = await db
    .select({ status: externalAccounts.status, version: externalAccounts.version })
    .from(externalAccounts)
    .where(
      and(
        eq(externalAccounts.workspaceId, auth.workspaceId),
        eq(externalAccounts.id, input.accountId),
      ),
    )
    .limit(1);
  if (!account) {
    throw new StaleWriteError("The connector account changed since you loaded it. Reload and try again.");
  }
  // A half-opened handshake has no credential to take away and no row worth
  // keeping; revoking it would hide a flow the owner may still finish.
  if (account.status === "connecting") {
    throw new ConflictError("That account is still connecting. Finish or abandon the connection first.");
  }
  // The caller's copy is out of date, so its intent cannot be trusted even if
  // the row happens to be revoked already.
  if (account.version !== input.expectedVersion) {
    throw new StaleWriteError("The connector account changed since you loaded it. Reload and try again.");
  }
  // Idempotent: a repeat with the same view is a success and writes nothing,
  // so a double click does not produce a second audit row.
  if (account.status === "revoked") return { revoked: false, version: account.version };

  const updated = await setAccountStatus(auth, {
    accountId: input.accountId,
    expectedVersion: input.expectedVersion,
    status: "revoked",
  });
  return { revoked: true, version: updated.version };
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
