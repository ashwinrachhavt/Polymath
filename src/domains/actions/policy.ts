import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { actionPolicies } from "./schema";

/*
 * ASH-289: sending grants scope to explicitly authorized sender aliases.
 *
 * The policy row's free-form constraints bag gains one understood key:
 *   { "allowedSenderAliases": ["work", "newsletters"] }
 * Only capabilities with a sender pin (ACCOUNT_PIN_PROVIDERS, today only
 * gmail.send) consult it. The rule is deny-by-omission only when the list is
 * present and non-empty: a workspace that never configures it keeps today's
 * behavior, and an empty list would read as "no sender may send", which no
 * owner writes on purpose - so it is treated as unconfigured.
 *
 * Enforcement is doubled on purpose: the pin path refuses to bind an
 * unauthorized alias into a NEW revision, and the executor re-checks the
 * current policy at send time, so tightening the list revokes already
 * approved proposals instead of grandfathering them.
 */

const constraintsSchema = z
  .object({
    allowedSenderAliases: z.array(z.string().trim().min(1)).optional(),
  })
  .strip();

export type SenderAliasPolicy = { configured: true; aliases: string[] } | { configured: false };

export function parseSenderAliasPolicy(constraints: unknown): SenderAliasPolicy {
  const parsed = constraintsSchema.safeParse(constraints ?? {});
  const aliases = parsed.success ? (parsed.data.allowedSenderAliases ?? []) : [];
  const unique = [...new Set(aliases)];
  return unique.length > 0 ? { configured: true, aliases: unique } : { configured: false };
}

export async function senderAliasPolicy(workspaceId: string, capability: string): Promise<SenderAliasPolicy> {
  const [row] = await db
    .select({ constraints: actionPolicies.constraints })
    .from(actionPolicies)
    .where(and(eq(actionPolicies.workspaceId, workspaceId), eq(actionPolicies.capability, capability)))
    .limit(1);
  return parseSenderAliasPolicy(row?.constraints);
}

export type SenderAliasVerdict = { allowed: true } | { allowed: false; reason: string };

/*
 * The alias check both enforcement points share. A NAMED alias outside the
 * list is refused outright; an unnamed sender is allowed through so the
 * resolver can pick inside the list - restricted resolution is what keeps
 * the one connected account from being substituted for an unauthorized
 * sender, and it fails honestly when no authorized account is connected.
 */
export function checkSenderAlias(policy: SenderAliasPolicy, alias: string | null): SenderAliasVerdict {
  if (!policy.configured) return { allowed: true };
  if (alias === null || policy.aliases.includes(alias)) return { allowed: true };
  return {
    allowed: false,
    reason: `"${alias}" is not an authorized sender for this capability. Authorized: ${policy.aliases.join(", ")}.`,
  };
}

/**
 * The owner's grant: which connected aliases a capability may send from.
 * Upserts the one policy row per (workspace, capability); the constraints bag
 * keeps any other keys it already carries.
 */
export async function setSenderAliasGrant(
  auth: AuthContext,
  capability: string,
  aliases: string[],
): Promise<{ aliases: string[] }> {
  const clean = [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))].sort();
  await withTransaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(actionPolicies)
      .where(and(eq(actionPolicies.workspaceId, auth.workspaceId), eq(actionPolicies.capability, capability)))
      .limit(1);
    const constraints = {
      ...((existing?.constraints ?? {}) as Record<string, unknown>),
      allowedSenderAliases: clean,
    };
    let policyId: string;
    if (existing) {
      await tx
        .update(actionPolicies)
        .set({ constraints, updatedAt: new Date(), updatedBy: auth.userId, version: existing.version + 1 })
        .where(and(eq(actionPolicies.id, existing.id), eq(actionPolicies.workspaceId, auth.workspaceId)));
      policyId = existing.id;
    } else {
      const [inserted] = await tx
        .insert(actionPolicies)
        .values({
          workspaceId: auth.workspaceId,
          capability,
          riskClass: "external_write",
          constraints,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: actionPolicies.id });
      policyId = inserted!.id;
    }
    await recordAudit(
      auth,
      {
        action: "policy.sender_aliases_set",
        subjectType: "action_policy",
        // audit_events.subject_id is uuid-typed: the policy row, never the capability string.
        subjectId: policyId,
        summary:
          clean.length > 0
            ? `Authorized senders for ${capability}: ${clean.join(", ")}`
            : `Sender restriction cleared for ${capability}`,
        metadata: { aliases: clean },
      },
      tx,
    );
  });
  return { aliases: clean };
}
