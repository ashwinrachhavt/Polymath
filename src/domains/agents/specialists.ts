import { and, eq } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { specialistBySlug, specialistProfileName } from "./roster";
import { agentProfiles } from "./schema";

/*
 * Create side of the specialist bench: a roster role or a custom brief becomes
 * an agent_profiles row, and hiring is engine.start against that row. No new
 * tables — agent_profiles already carries instructions, tool scope, model and
 * budget policy, and the run freezes all of it into the policy snapshot.
 *
 * The install is idempotent on (workspace, name): a double-click or a re-run
 * returns the existing profile rather than a second row (the unique index is
 * the guarantee, onConflictDoNothing is the mechanism). A custom specialist
 * whose name collides with an existing profile is a conflict the caller sees,
 * not a silent reuse.
 */

const SPECIALIST_MODEL_POLICY = { primary: "claude-hive-glm-5.3-flash" };
const SPECIALIST_BUDGET_POLICY = { perRunCeilingUsd: "2.00", dailyCeilingUsd: "10.00" };

function clean(value: string, max: number): string {
  return value.trim().slice(0, max);
}

export async function installSpecialist(
  auth: AuthContext,
  input: { slug: string },
): Promise<{ profileId: string; name: string; created: boolean }> {
  const definition = specialistBySlug(input.slug);
  if (!definition) throw new Error(`Unknown specialist: ${input.slug}`);
  const name = specialistProfileName(definition.slug);

  return withTransaction(async (tx) => {
    const [existing] = await tx
      .select({ id: agentProfiles.id })
      .from(agentProfiles)
      .where(and(eq(agentProfiles.workspaceId, auth.workspaceId), eq(agentProfiles.name, name)))
      .limit(1);
    if (existing) return { profileId: existing.id, name, created: false };

    const [profile] = await tx
      .insert(agentProfiles)
      .values({
        workspaceId: auth.workspaceId,
        name,
        description: `${definition.name} (${definition.team}) — ${definition.mission}`,
        instructions: definition.instructions,
        modelPolicy: SPECIALIST_MODEL_POLICY,
        allowedTools: definition.allowedTools,
        budgetPolicy: SPECIALIST_BUDGET_POLICY,
        isDefault: false,
      })
      .onConflictDoNothing()
      .returning({ id: agentProfiles.id });
    // A race that beat this insert is still one profile: read it back.
    const profileId =
      profile?.id ??
      (await tx
        .select({ id: agentProfiles.id })
        .from(agentProfiles)
        .where(and(eq(agentProfiles.workspaceId, auth.workspaceId), eq(agentProfiles.name, name)))
        .limit(1))[0]?.id;
    if (!profileId) throw new Error("specialist profile did not persist");

    if (profile) {
      await recordAudit(
        auth,
        {
          action: "specialist.installed",
          subjectType: "agent_profile",
          subjectId: profileId,
          summary: `Specialist installed: ${definition.name}`,
        },
        tx,
      );
    }
    return { profileId, name, created: Boolean(profile) };
  });
}

export async function createCustomSpecialist(
  auth: AuthContext,
  input: { name: string; mission: string; instructions: string; allowedTools: string[] },
): Promise<{ profileId: string; name: string; created: boolean }> {
  const shortName = clean(input.name, 60);
  if (!shortName) throw new Error("Give the specialist a name.");
  const instructions = clean(input.instructions, 8000);
  if (!instructions) throw new Error("Give the specialist a brief (instructions).");
  // Profile names are the driver's routing key, so custom specialists share
  // the specialist: prefix with the roster installs.
  const name = `specialist:custom:${shortName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  const [existing] = await db
    .select({ id: agentProfiles.id })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.workspaceId, auth.workspaceId), eq(agentProfiles.name, name)))
    .limit(1);
  if (existing) throw new Error(`A specialist named "${shortName}" already exists.`);

  return withTransaction(async (tx) => {
    const [profile] = await tx
      .insert(agentProfiles)
      .values({
        workspaceId: auth.workspaceId,
        name,
        description: clean(input.mission, 300),
        instructions,
        modelPolicy: SPECIALIST_MODEL_POLICY,
        allowedTools: input.allowedTools,
        budgetPolicy: SPECIALIST_BUDGET_POLICY,
        isDefault: false,
      })
      .onConflictDoNothing()
      .returning({ id: agentProfiles.id });
    if (!profile) throw new Error(`A specialist named "${shortName}" already exists.`);
    await recordAudit(
      auth,
      {
        action: "specialist.created",
        subjectType: "agent_profile",
        subjectId: profile.id,
        summary: `Custom specialist created: ${shortName}`,
      },
      tx,
    );
    return { profileId: profile.id, name, created: true };
  });
}
