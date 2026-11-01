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

/**
 * The onboarding interview's agent profile. ensureProfile creates the row;
 * this constant is the one home for its lookup convention, so callers never
 * hand-write the name.
 */
export const ONBOARDING_PROFILE_NAME = "polymath";

/**
 * The onboarding profile's model policy, or null when no profile exists yet
 * (first visit — ensureProfile has not run). The start action reads it for
 * the credential gate (QA F7) instead of importing db and the domain schema
 * directly: the UI-to-domain dependency keeps pointing inward.
 */
export async function readOnboardingModelPolicy(workspaceId: string): Promise<unknown> {
  const [profile] = await db
    .select({ modelPolicy: agentProfiles.modelPolicy })
    .from(agentProfiles)
    .where(
      and(eq(agentProfiles.workspaceId, workspaceId), eq(agentProfiles.name, ONBOARDING_PROFILE_NAME)),
    )
    .limit(1);
  return profile?.modelPolicy ?? null;
}

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
    await ensureProfile(auth.workspaceId, "polymath");
    const [profile] = await tx
      .select({ id: agentProfiles.id, version: agentProfiles.version })
      .from(agentProfiles)
      .where(and(eq(agentProfiles.workspaceId, auth.workspaceId), eq(agentProfiles.name, "polymath")))
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

/* ------------------------------------------------------------------------- *
 * The agent-led interview (ASH-296).
 *
 * The interview is a real run through the engine — transcript in run_events,
 * spend reserved, reload-safe by construction — started with a fixed
 * objective that scripts the conversation and a tool ceiling of none. The
 * agent's final turn closes with a fenced `onboarding-brief` JSON payload
 * riding the ordinary assistant message (see onboarding-brief.ts); the
 * confirm card is derived from that persisted event, never from browser
 * state, and the commit path is the unchanged completeOnboarding above.
 * ------------------------------------------------------------------------- */

import { agentRuns } from "./schema";
import { desc, inArray } from "drizzle-orm";
import { createEngine, type SessionDriver } from "./engine";
import { createEveDriver, eveAgentForProfile } from "./eve-driver";
import { listThreads, type ThreadEntry } from "./thread";
import {
  extractOnboardingBrief,
  prefillOnboardingFromThread,
  ONBOARDING_BRIEF_FENCE,
  type OnboardingBrief,
} from "./onboarding-brief";

export const ONBOARDING_OBJECTIVE = [
  "onboarding-interview v1",
  "This session is the workspace's first-run onboarding interview. You are the person's own agent, meeting them for the first time.",
  "Learn four things, in one short warm conversation: (1) what they do — their role, (2) which tools they work in every day, (3) what they most want to get done, (4) what they would like to call you.",
  "Ask about one topic at a time, with at most one clarifying follow-up per topic. The whole interview is at most 6 turns; when you know all four, close.",
  "On your final turn, write a two-sentence summary of what you learned, then emit exactly this fenced block as the last thing in your reply:",
  ONBOARDING_BRIEF_FENCE,
  '{"role":"...","tools":["..."],"priorities":["..."],"agentName":"..."}',
  "```",
  'The fence must contain only valid JSON with exactly those keys, and no text follows it. If they did not pick a name, use "Polymath".',
].join("\n");

const LIVE_RUN_STATES = ["queued", "running", "waiting_input", "waiting_approval"] as const;

/** The workspace's in-flight interview run, if one is open. */
export async function findLiveOnboardingRun(workspaceId: string) {
  const [run] = await db
    .select({ id: agentRuns.id, state: agentRuns.state })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workspaceId, workspaceId),
        eq(agentRuns.objective, ONBOARDING_OBJECTIVE),
        inArray(agentRuns.state, [...LIVE_RUN_STATES]),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return run ?? null;
}

/** The most recent interview run in any state — for reload-after-finish recovery. */
export async function findLatestOnboardingRun(workspaceId: string) {
  const [run] = await db
    .select({ id: agentRuns.id, state: agentRuns.state })
    .from(agentRuns)
    .where(and(eq(agentRuns.workspaceId, workspaceId), eq(agentRuns.objective, ONBOARDING_OBJECTIVE)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return run ?? null;
}

/**
 * Start the interview run, or resume the one already open. Resume-first is
 * what makes the page reload-safe: two starts (a double mount, a retried
 * action) converge on one run instead of forking two sessions and two spend
 * reservations. The in-progress session row is claimed before the run exists
 * so an abandoned interview still resumes (its row stays in_progress until
 * completeOnboarding flips it).
 */
export async function startOnboardingRun(
  auth: AuthContext,
  driver?: SessionDriver,
): Promise<{ runId: string; resumed: boolean }> {
  const live = await findLiveOnboardingRun(auth.workspaceId);
  if (live) return { runId: live.id, resumed: true };

  const session = await getOnboardingSession(auth.workspaceId);
  if (!session) {
    try {
      await db.insert(onboardingSessions).values({
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        status: "in_progress",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      });
    } catch {
      // A concurrent start claimed the live-session slot first; the run below
      // is still resume-first, so the worst case is the other tab's run.
    }
  }

  await ensureProfile(auth.workspaceId, "polymath");
  const engine = createEngine(driver ?? createEveDriver(eveAgentForProfile("polymath")));
  const { runId } = await engine.start({
    auth,
    profileName: "polymath",
    objective: ONBOARDING_OBJECTIVE,
    subjects: [],
    // The interview is conversation only: no tools, and a dime of headroom.
    estimateUsd: "0.10",
    allowedTools: [],
  });
  return { runId, resumed: false };
}

export type OnboardingRunReading = {
  thread: ThreadEntry[];
  /** The validated brief from the final turn, when the agent emitted a well-formed one. */
  brief: OnboardingBrief | null;
  /** Salvaged fields for the extraction-failure form; empty when nothing parseable was said. */
  prefill: Partial<OnboardingBrief>;
  /** The alfred profile version at read time, so the confirm submit carries the race guard. */
  profileVersion: number | null;
};

/**
 * Read an interview run's thread and derive what the confirm card needs.
 * Scoped to the workspace through listThreads; the last assistant message is
 * where the brief lives, so only that text is parsed.
 */
export async function readOnboardingRun(auth: AuthContext, runId: string): Promise<OnboardingRunReading | null> {
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!run) return null;

  const [threads, [profile]] = await Promise.all([
    listThreads(auth.workspaceId, [runId]),
    db
      .select({ version: agentProfiles.version })
      .from(agentProfiles)
      .where(and(eq(agentProfiles.workspaceId, auth.workspaceId), eq(agentProfiles.name, "polymath")))
      .limit(1),
  ]);
  const thread = threads.get(runId) ?? [];
  const lastAssistant = [...thread].reverse().find((entry) => entry.kind === "assistant");
  const text = lastAssistant?.text ?? "";
  return {
    thread,
    brief: extractOnboardingBrief(text),
    prefill: prefillOnboardingFromThread(text),
    profileVersion: profile?.version ?? null,
  };
}
