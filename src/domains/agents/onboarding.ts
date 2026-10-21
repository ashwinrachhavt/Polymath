import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/lib/auth";
import { agentProfiles, onboardingSessions } from "./schema";
import { ensureProfile } from "./commands";

/*
 * Onboarding is one conversation with the workspace's future supervisor agent.
 * The person describes who they are — what they do, which tools they live in,
 * what they most want done — and the flow writes what it learned into the
 * workspace's agent profile. The agent that greets them afterwards is theirs:
 * named by them, briefed on them, aimed at what they said matters (the
 * personified-supervisor decision in agents/product.md, 2026-10-21).
 *
 * State lives in onboarding_sessions so a half-finished flow resumes. The
 * profile is the only durable home for what was learned; the session row keeps
 * the brief verbatim as provenance.
 *
 * Every statement in completeOnboarding runs on the one transaction, and the
 * workspace stamp is raw SQL by design: importing the workspaces table object
 * here pulls identity/tables through a second bundle instance in the Turbopack
 * action chunk, where the shared table symbol resolves to a copy without its
 * columns (`Symbol(drizzle:Columns)` of undefined). db/columns and
 * identity/schema already form a cycle; raw SQL keeps it from biting here.
 */

export type OnboardingStatus = "in_progress" | "completed" | "abandoned";

export type OnboardingInput = {
  role: string;
  tools: string[];
  priorities: string[];
};

export async function getOnboardingSession(workspaceId: string) {
  const [session] = await db
    .select()
    .from(onboardingSessions)
    .where(
      and(
        eq(onboardingSessions.workspaceId, workspaceId),
        eq(onboardingSessions.status, "in_progress"),
        isNull(onboardingSessions.archivedAt),
      ),
    )
    .limit(1);
  return session ?? null;
}

export async function isWorkspaceOnboarded(workspaceId: string) {
  // Raw SQL for the same reason completeOnboarding stamps raw SQL: the
  // workspaces table object must not be imported into this module.
  const [row] = await db
    .select({ onboardedAt: sql<Date | null>`(select onboarded_at from workspaces where id = ${workspaceId})` })
    .from(sql`(select 1) as probe`);
  return row?.onboardedAt != null;
}

/**
 * Record what onboarding learned and personify the supervisor agent in the
 * same commit. The profile description is replaced, not appended: it is the
 * personified brief, and a stale placeholder behind it would make the run's
 * idea of the agent disagree with the settings screen.
 */
export async function completeOnboarding(
  auth: AuthContext,
  input: OnboardingInput & { agentName: string; expectedVersion?: number },
) {
  const { agentName, role, tools, priorities, expectedVersion } = input;
  const brief = [
    `The user is ${role}.`,
    `They work in: ${tools.join(", ") || "no connected tools yet"}.`,
    `What matters most to them: ${priorities.join("; ") || "not stated yet"}.`,
    "You are their own agent — their representation, not a generic assistant. Aim every answer at what matters to them.",
  ].join("\n");

  return withTransaction(async (tx) => {
    await ensureProfile(auth.workspaceId, "alfred");
    const [profile] = await tx
      .select({ id: agentProfiles.id, version: agentProfiles.version })
      .from(agentProfiles)
      .where(and(eq(agentProfiles.workspaceId, auth.workspaceId), eq(agentProfiles.name, "alfred")))
      .limit(1);
    if (!profile) throw new Error("supervisor profile did not persist");
    if (expectedVersion != null && profile.version !== expectedVersion) {
      throw new Error("The agent profile changed in another tab. Reload and try again.");
    }
    await tx
      .update(agentProfiles)
      .set({
        description: brief,
        instructions: brief,
        updatedBy: auth.userId,
        updatedAt: new Date(),
        version: profile.version + 1,
      })
      .where(eq(agentProfiles.id, profile.id));

    // One live session per workspace (partial unique index); claim it or start
    // a fresh one if a previous flow was abandoned.
    const [existing] = await tx
      .select({ id: onboardingSessions.id, version: onboardingSessions.version })
      .from(onboardingSessions)
      .where(
        and(
          eq(onboardingSessions.workspaceId, auth.workspaceId),
          eq(onboardingSessions.status, "in_progress"),
          isNull(onboardingSessions.archivedAt),
        ),
      )
      .limit(1);
    if (existing) {
      await tx
        .update(onboardingSessions)
        .set({
          status: "completed",
          role,
          tools,
          priorities,
          personifiedBrief: brief,
          completedAt: new Date(),
          updatedBy: auth.userId,
          updatedAt: new Date(),
          version: existing.version + 1,
        })
        .where(eq(onboardingSessions.id, existing.id));
    } else {
      await tx.insert(onboardingSessions).values({
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        status: "completed",
        role,
        tools,
        priorities,
        personifiedBrief: brief,
        completedAt: new Date(),
        createdBy: auth.userId,
        updatedBy: auth.userId,
      });
    }

    await tx.execute(
      sql`update workspaces set onboarded_at = now(), updated_by = ${auth.userId}, updated_at = now() where id = ${auth.workspaceId}`,
    );

    await recordAudit(
      auth,
      {
        action: "onboarding.completed",
        subjectType: "workspace",
        subjectId: auth.workspaceId,
        summary: `Personified the supervisor agent as ${agentName}`,
      },
      tx,
    );
    return { brief };
  });
}
