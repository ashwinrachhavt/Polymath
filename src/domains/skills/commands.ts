import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import type { InspectedSkill } from "./manifest";
import { skills, type SkillSourceKind } from "./schema";

/*
 * Writes for the skills library. Install is idempotent on the identity index,
 * because inspection is stateless: the install action re-fetches the pinned
 * revision and a double submit must land on one row, not two.
 *
 * Nothing imported is executed here; the body and files are persisted as data
 * and only ever read back as text.
 */

export async function installSkill(
  auth: AuthContext,
  input: InspectedSkill & {
    sourceKind: SkillSourceKind;
    sourceRef: string;
    sourcePath: string;
    revision: string;
  },
): Promise<{ skillId: string; created: boolean }> {
  return withTransaction(async (tx) => {
    const [inserted] = await tx
      .insert(skills)
      .values({
        workspaceId: auth.workspaceId,
        slug: input.slug,
        name: input.name,
        description: input.description,
        body: input.body,
        files: input.files,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        sourcePath: input.sourcePath,
        revision: input.revision,
        contentHash: input.contentHash,
        warnings: input.warnings,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing()
      .returning({ id: skills.id });

    if (!inserted) {
      // The unique index is the guarantee, this read-back is how a double
      // submit finds the row that won; losing the race is not an error.
      const [existing] = await tx
        .select({ id: skills.id })
        .from(skills)
        .where(
          and(
            eq(skills.workspaceId, auth.workspaceId),
            eq(skills.sourceKind, input.sourceKind),
            eq(skills.sourceRef, input.sourceRef),
            eq(skills.sourcePath, input.sourcePath),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("The skill did not persist. Try installing it again.");
      return { skillId: existing.id, created: false };
    }

    await recordAudit(
      auth,
      {
        action: "skill.installed",
        subjectType: "skill",
        subjectId: inserted.id,
        summary: `Skill installed: ${input.name}`,
        metadata: {
          sourceKind: input.sourceKind,
          sourceRef: input.sourceRef,
          sourcePath: input.sourcePath,
          revision: input.revision,
        },
      },
      tx,
    );
    return { skillId: inserted.id, created: true };
  });
}

/** `false` means the id is not in this workspace; it is not an error to learn it does not exist. */
export async function setSkillEnabled(
  auth: AuthContext,
  input: { id: string; enabled: boolean },
): Promise<{ updated: boolean }> {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .update(skills)
      .set({
        enabled: input.enabled,
        updatedBy: auth.userId,
        updatedAt: new Date(),
        version: sql`${skills.version} + 1`,
      })
      .where(and(eq(skills.workspaceId, auth.workspaceId), eq(skills.id, input.id)))
      .returning({ id: skills.id });
    if (!row) return { updated: false };

    await recordAudit(
      auth,
      {
        action: input.enabled ? "skill.enabled" : "skill.disabled",
        subjectType: "skill",
        subjectId: row.id,
        summary: input.enabled ? "Skill enabled" : "Skill disabled",
      },
      tx,
    );
    return { updated: true };
  });
}

/*
 * A hard delete, because the row is a copy of something that still exists at
 * its source. Provenance for past runs lives in agent_runs.policy_snapshot,
 * not here, so the run history survives the row. The audit row is written
 * before the delete only so the delete is the last thing that can fail; both
 * statements share the transaction, so a rollback drops the audit row too.
 */
export async function removeSkill(
  auth: AuthContext,
  input: { id: string },
): Promise<{ removed: boolean }> {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .select({ id: skills.id, name: skills.name })
      .from(skills)
      .where(and(eq(skills.workspaceId, auth.workspaceId), eq(skills.id, input.id)))
      .limit(1);
    if (!row) return { removed: false };

    await recordAudit(
      auth,
      {
        action: "skill.removed",
        subjectType: "skill",
        subjectId: row.id,
        summary: `Skill removed: ${row.name}`,
      },
      tx,
    );
    await tx.delete(skills).where(and(eq(skills.workspaceId, auth.workspaceId), eq(skills.id, row.id)));
    return { removed: true };
  });
}
