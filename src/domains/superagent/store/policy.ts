/**
 * The Policy's durable settings: one document per workspace plus its rule list,
 * read by the policy port's implementation and written by the settings surface.
 *
 * The `version` hash is supplied by the caller — it covers the whole document
 * (rules, accept mode, source parts) by the policy module's hashing rules, and
 * a PolicySnapshot freezes it per assessment. The store persists the document
 * and the rules it names; it does not interpret them.
 */
import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AcceptMode } from "../core/model";
import { superagentPolicies, superagentPolicyRules } from "./schema";
import type { PolicyRuleRow, PolicySourcePart, SuperagentPolicyRow } from "./schema";

export type PolicyDocument = {
  version: string;
  paused: boolean;
  acceptMode: AcceptMode;
  evalTimeoutMs: number;
  sources: Record<string, PolicySourcePart>;
};

export type StoredPolicy = { policy: PolicyDocument; rules: PolicyRuleRow[] };

export function policyRowToDocument(row: SuperagentPolicyRow): PolicyDocument {
  return {
    version: row.version,
    paused: row.paused,
    acceptMode: row.acceptMode as AcceptMode,
    evalTimeoutMs: row.evalTimeoutMs,
    sources: row.sources,
  };
}

export function rulesToRows(
  workspaceId: string,
  rules: PolicyRuleRow[],
): (typeof superagentPolicyRules.$inferInsert)[] {
  return rules.map((rule) => ({
    workspaceId,
    ruleId: rule.id,
    name: rule.name,
    instruction: rule.instruction,
    enabled: rule.enabled,
    position: rule.position,
  }));
}

/** Saves the policy document and replaces the rule list wholesale, in one transaction. */
export async function savePolicy(
  db: PostgresJsDatabase,
  workspaceId: string,
  policy: PolicyDocument,
  rules: PolicyRuleRow[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = {
      workspaceId,
      version: policy.version,
      paused: policy.paused,
      acceptMode: policy.acceptMode,
      evalTimeoutMs: policy.evalTimeoutMs,
      sources: policy.sources,
      updatedAt: new Date(),
    };
    await tx
      .insert(superagentPolicies)
      .values(row)
      .onConflictDoUpdate({ target: superagentPolicies.workspaceId, set: row });
    await tx.delete(superagentPolicyRules).where(and(eq(superagentPolicyRules.workspaceId, workspaceId)));
    if (rules.length > 0) await tx.insert(superagentPolicyRules).values(rulesToRows(workspaceId, rules));
  });
}

/** The workspace's stored policy, or `undefined` before anyone saved one. */
export async function getPolicy(db: PostgresJsDatabase, workspaceId: string): Promise<StoredPolicy | undefined> {
  const [row] = await db.select().from(superagentPolicies).where(eq(superagentPolicies.workspaceId, workspaceId));
  if (!row) return undefined;
  const rules = await db
    .select({
      id: superagentPolicyRules.ruleId,
      name: superagentPolicyRules.name,
      instruction: superagentPolicyRules.instruction,
      enabled: superagentPolicyRules.enabled,
      position: superagentPolicyRules.position,
    })
    .from(superagentPolicyRules)
    .where(eq(superagentPolicyRules.workspaceId, workspaceId))
    .orderBy(asc(superagentPolicyRules.position));
  return { policy: policyRowToDocument(row), rules };
}
