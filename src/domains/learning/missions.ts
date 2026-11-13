import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { conceptKey, conceptName, resolveConceptIds } from "@/domains/knowledge/concepts";
import { concepts } from "@/domains/knowledge/schema";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import {
  defaultMissionConceptGenerator,
  MAX_MISSION_CONCEPTS,
  MISSION_CONCEPT_PROMPT_VERSION,
  type MissionConceptGenerator,
  type ProposedMissionConcept,
} from "@/integrations/learning/mission-concepts";
import { loadCurrentQuizSources, QuizGenerationError } from "./generate-quiz";
import { locateQuoteNormalized } from "./locate-quote";
import { missionConcepts, missions, type Mission, type MissionSourceSnapshot } from "./schema";

/*
 * Missions: what someone must be able to do, by when, and the short list of
 * concepts they will prove. The concept list is proposed in the background
 * (a generation job), verified against the pinned sources, de-duplicated
 * against the workspace's existing concepts, and then edited by its owner
 * before the Mission starts.
 *
 * The trust boundary is the quiz generator's. The model proposes names and
 * passages; the domain keeps a concept only when its quote locates verbatim
 * in the source it names. A proposal with no locatable source is dropped, so
 * a Mission can never send someone to study something they did not bring.
 */

export class MissionError extends Error {
  constructor(
    public readonly code:
      | "invalid_goal"
      | "no_sources"
      | "invalid_sources"
      | "source_not_ready"
      | "mission_not_found"
      | "not_owner"
      | "no_concepts"
      | "already_active"
      | "generation_failed",
    message: string,
  ) {
    super(message);
    this.name = "MissionError";
  }
}

const MISSION_GOAL_MAX = 500;
const MISSION_ROLE_MAX = 2000;

/** The minimum a Mission needs to exist: a one-sentence goal and at least one ready source. */
export type MissionDraft = {
  goal: string;
  role: string | null;
  dueOn: string | null;
};

function normalizeDraft(input: MissionDraft): MissionDraft {
  const goal = input.goal.replace(/\s+/g, " ").trim();
  if (goal.length === 0 || goal.length > MISSION_GOAL_MAX) {
    throw new MissionError(
      "invalid_goal",
      `Say in one sentence what you need to be able to do (up to ${MISSION_GOAL_MAX} characters).`,
    );
  }
  const role = input.role?.replace(/\s+/g, " ").trim().slice(0, MISSION_ROLE_MAX) || null;
  const dueOn = input.dueOn?.trim() || null;
  if (dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
    throw new MissionError("invalid_goal", "The date must be a real day, like 2026-12-01.");
  }
  return { goal, role, dueOn };
}

/**
 * Accepts a Mission and its sources and returns at once, with the Mission
 * waiting on its concept job. The caller submits and starts the job; this
 * writes the draft row and its pinned source snapshots so the job has stable
 * input even if the sources change later.
 */
export async function createMission(
  auth: AuthContext,
  input: MissionDraft & { documentIds: string[]; requestKey: string },
): Promise<{ missionId: string; sourceManifest: MissionSourceSnapshot[]; created: boolean }> {
  const draft = normalizeDraft(input);
  const requestKey = input.requestKey.trim();
  if (!requestKey) throw new MissionError("invalid_goal", "This request is missing its key.");
  if (input.documentIds.length === 0) {
    throw new MissionError("no_sources", "Choose at least one source to study from.");
  }
  let sources;
  try {
    sources = await loadCurrentQuizSources(auth, input.documentIds);
  } catch (cause) {
    if (cause instanceof QuizGenerationError) {
      throw new MissionError(
        cause.code === "no_extraction" ? "source_not_ready" : "invalid_sources",
        cause.code === "no_extraction"
          ? "Every source must finish reading before it can plan a Mission."
          : "One or more sources are unavailable in this workspace.",
      );
    }
    throw cause;
  }
  const manifest: MissionSourceSnapshot[] = sources.map(({ documentId, extractionId, title }) => ({
    documentId,
    extractionId,
    title,
  }));
  return withTransaction(async (tx) => {
    // A repeat of the same intent returns the Mission already made: a
    // double-click is one Mission and one concept job, from the database's
    // own uniqueness rather than a read-then-write race.
    const [row] = await tx
      .insert(missions)
      .values({
        workspaceId: auth.workspaceId,
        goal: draft.goal,
        role: draft.role,
        dueOn: draft.dueOn,
        status: "draft",
        sourceManifest: manifest,
        requestKey,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing({ target: [missions.workspaceId, missions.requestKey] })
      .returning({ id: missions.id, sourceManifest: missions.sourceManifest });
    if (!row) {
      const [prior] = await tx
        .select({ id: missions.id, sourceManifest: missions.sourceManifest })
        .from(missions)
        .where(and(eq(missions.workspaceId, auth.workspaceId), eq(missions.requestKey, requestKey)))
        .limit(1);
      if (!prior) throw new MissionError("generation_failed", "The Mission could not be saved. Try again.");
      return { missionId: prior.id, sourceManifest: prior.sourceManifest, created: false };
    }
    await recordAudit(
      auth,
      {
        action: "learning.mission_started",
        subjectType: "mission",
        subjectId: row.id,
        summary: "Started a Mission",
        metadata: { sourceCount: manifest.length, dated: draft.dueOn !== null },
      },
      tx,
    );
    return { missionId: row.id, sourceManifest: manifest, created: true };
  });
}

/** The sources a Mission's concept job reads, by its pinned manifest. */
async function missionSources(
  auth: AuthContext,
  manifest: MissionSourceSnapshot[],
): Promise<Array<{ title: string; text: string }>> {
  if (manifest.length === 0) throw new MissionError("no_sources", "This Mission has no sources.");
  try {
    return await loadCurrentQuizSources(
      auth,
      manifest.map((item) => item.documentId),
    );
  } catch {
    throw new MissionError("source_not_ready", "A source this Mission was built from is no longer readable.");
  }
}

/** A proposal that survived verification: a real concept name, why it matters, and the passage it came from. */
type AcceptedConcept = {
  name: string;
  reason: string;
  sourceQuote: string;
  sourceDocumentId: string;
};

/**
 * The verification step, pure and testable: locate each proposal's quote in
 * the source it names, keep the ones that locate, drop proposals whose name
 * duplicates one already kept (their first mention wins), and cap the list at
 * MAX_MISSION_CONCEPTS. Never invents anything - a proposal with no locatable
 * source is discarded.
 */
function acceptProposedConcepts(
  proposed: ProposedMissionConcept[],
  sources: Array<{ documentId: string; title: string; text: string }>,
): AcceptedConcept[] {
  const accepted: AcceptedConcept[] = [];
  const seen = new Set<string>();
  for (const item of proposed) {
    const source = sources[item.sourceIndex];
    if (!source) continue;
    const name = conceptName(item.name);
    if (!name) continue;
    const key = conceptKey(name);
    if (seen.has(key)) continue;
    const span = locateQuoteNormalized(source.text, item.quote);
    if (!span) continue;
    seen.add(key);
    accepted.push({
      name,
      reason: item.reason.trim().slice(0, 240),
      sourceQuote: source.text.slice(span.start, span.end).slice(0, 500),
      sourceDocumentId: source.documentId,
    });
    if (accepted.length >= MAX_MISSION_CONCEPTS) break;
  }
  return accepted;
}

/**
 * Writes the concept list a Mission is waiting for. Runs after the request
 * that started it has returned. Only a draft Mission with no concepts is
 * written to, so a replay changes nothing.
 */
export async function prepareMissionConcepts(
  auth: AuthContext,
  missionId: string,
  generator?: MissionConceptGenerator,
): Promise<{ conceptCount: number }> {
  const [mission] = await db
    .select({
      id: missions.id,
      goal: missions.goal,
      role: missions.role,
      status: missions.status,
      sourceManifest: missions.sourceManifest,
    })
    .from(missions)
    .where(and(eq(missions.id, missionId), eq(missions.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!mission) throw new MissionError("mission_not_found", "That Mission is not available.");
  if (mission.status !== "draft") return { conceptCount: 0 };

  const existingRows = await db
    .select({ term: concepts.term })
    .from(concepts)
    .where(and(eq(concepts.workspaceId, auth.workspaceId), eq(concepts.sense, "domain")))
    .orderBy(desc(concepts.updatedAt))
    .limit(60);

  const sources = await missionSources(auth, mission.sourceManifest);
  const engine = generator ?? (await defaultMissionConceptGenerator(auth.workspaceId));
  let proposed: ProposedMissionConcept[];
  try {
    proposed = (
      await engine.propose({
        goal: mission.goal,
        role: mission.role,
        sources,
        existing: existingRows.map((r) => r.term),
      })
    ).concepts;
  } catch (cause) {
    throw new MissionError(
      "generation_failed",
      cause instanceof Error && cause.message ? cause.message : "Making your concepts failed. Try again.",
    );
  }

  const accepted = acceptProposedConcepts(
    proposed,
    mission.sourceManifest.map((pin, index) => ({
      documentId: pin.documentId,
      title: pin.title,
      text: sources[index]?.text ?? "",
    })),
  );
  if (accepted.length === 0) {
    throw new MissionError(
      "generation_failed",
      "The sources did not give any concepts grounded enough to plan a Mission. Try a longer or clearer source.",
    );
  }

  return withTransaction(async (tx) => {
    // A Mission that already has concepts is done: a replay never doubles a plan.
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(missionConcepts)
      .where(and(eq(missionConcepts.workspaceId, auth.workspaceId), eq(missionConcepts.missionId, mission.id)));
    if (count > 0) return { conceptCount: count };

    const ids = await resolveConceptIds(
      auth,
      accepted.map((item) => item.name),
      tx,
    );
    const rows = accepted.flatMap((item, index) => {
      const conceptId = ids.get(conceptKey(item.name));
      return conceptId
        ? [
            {
              workspaceId: auth.workspaceId,
              missionId: mission.id,
              conceptId,
              ordinal: index,
              reason: item.reason,
              sourceQuote: item.sourceQuote,
              sourceDocumentId: item.sourceDocumentId,
            },
          ]
        : [];
    });
    if (rows.length > 0) await tx.insert(missionConcepts).values(rows);
    await recordAudit(
      auth,
      {
        action: "learning.mission_concepts_proposed",
        subjectType: "mission",
        subjectId: mission.id,
        summary: "Proposed the concepts for a Mission",
        metadata: { proposed: proposed.length, accepted: rows.length, promptVersion: MISSION_CONCEPT_PROMPT_VERSION },
      },
      tx,
    );
    return { conceptCount: rows.length };
  });
}

/** One concept of a Mission, as the plan editor and the report show it. */
type MissionConceptView = {
  id: string;
  conceptId: string;
  name: string;
  reason: string;
  sourceQuote: string | null;
  ordinal: number;
};

export type MissionView = {
  id: string;
  goal: string;
  role: string | null;
  dueOn: string | null;
  status: Mission["status"];
  sourceTitles: string[];
  concepts: MissionConceptView[];
  createdAt: Date;
};

async function conceptViews(auth: AuthContext, missionId: string): Promise<MissionConceptView[]> {
  const rows = await db
    .select({
      id: missionConcepts.id,
      conceptId: missionConcepts.conceptId,
      name: concepts.term,
      reason: missionConcepts.reason,
      sourceQuote: missionConcepts.sourceQuote,
      ordinal: missionConcepts.ordinal,
    })
    .from(missionConcepts)
    .innerJoin(concepts, eq(concepts.id, missionConcepts.conceptId))
    .where(and(eq(missionConcepts.workspaceId, auth.workspaceId), eq(missionConcepts.missionId, missionId)))
    .orderBy(asc(missionConcepts.ordinal));
  return rows;
}

/** Every Mission in the workspace, newest first, with its plan. */
export async function listMissions(auth: AuthContext): Promise<MissionView[]> {
  const rows = await db
    .select()
    .from(missions)
    .where(and(eq(missions.workspaceId, auth.workspaceId), sql`${missions.status} <> 'archived'`))
    .orderBy(desc(missions.createdAt), desc(missions.id));
  const out: MissionView[] = [];
  for (const row of rows) {
    out.push({
      id: row.id,
      goal: row.goal,
      role: row.role,
      dueOn: row.dueOn,
      status: row.status,
      sourceTitles: row.sourceManifest.map((item) => item.title),
      concepts: await conceptViews(auth, row.id),
      createdAt: row.createdAt,
    });
  }
  return out;
}

/** One Mission by id, scoped to the workspace; null for another workspace's. */
export async function getMission(auth: AuthContext, missionId: string): Promise<MissionView | null> {
  const [row] = await db
    .select()
    .from(missions)
    .where(and(eq(missions.id, missionId), eq(missions.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    goal: row.goal,
    role: row.role,
    dueOn: row.dueOn,
    status: row.status,
    sourceTitles: row.sourceManifest.map((item) => item.title),
    concepts: await conceptViews(auth, row.id),
    createdAt: row.createdAt,
  };
}

/**
 * The owner edits the plan before the Mission starts: keep the concepts they
 * want, drop the rest, and add one of their own. A concept added by hand
 * carries no source quote - it was not drawn from a passage - so it is kept
 * apart from the proposals and never claims a citation. Ordinals are then
 * rewritten so the plan reads in the order the owner sees.
 *
 * Only a draft Mission can be edited; a started Mission's plan is frozen.
 */
export async function setMissionConcepts(
  auth: AuthContext,
  missionId: string,
  input: { keepConceptIds: string[]; added: Array<{ name: string; reason?: string }> },
): Promise<MissionView> {
  const mission = await getMission(auth, missionId);
  if (!mission) throw new MissionError("mission_not_found", "That Mission is not available.");
  if (mission.status !== "draft") throw new MissionError("already_active", "This Mission has already started.");

  const keep = new Set(input.keepConceptIds);
  const added = input.added
    .map((item) => ({ name: conceptName(item.name), reason: (item.reason ?? "").trim().slice(0, 240) }))
    .filter((item) => item.name.length > 0);
  if (keep.size === 0 && added.length === 0) {
    throw new MissionError("no_concepts", "Keep at least one concept to work on.");
  }
  if (keep.size + added.length > MAX_MISSION_CONCEPTS) {
    throw new MissionError("no_concepts", `A Mission works on at most ${MAX_MISSION_CONCEPTS} concepts.`);
  }

  return withTransaction(async (tx) => {
    const current = await tx
      .select({ id: missionConcepts.id, conceptId: missionConcepts.conceptId, ordinal: missionConcepts.ordinal })
      .from(missionConcepts)
      .where(and(eq(missionConcepts.workspaceId, auth.workspaceId), eq(missionConcepts.missionId, missionId)));
    const drop = current.filter((row) => !keep.has(row.conceptId)).map((row) => row.id);
    if (drop.length > 0) {
      await tx
        .delete(missionConcepts)
        .where(and(eq(missionConcepts.workspaceId, auth.workspaceId), inArray(missionConcepts.id, drop)));
    }

    if (added.length > 0) {
      const ids = await resolveConceptIds(
        auth,
        added.map((item) => item.name),
        tx,
      );
      // A new concept goes after everything already kept.
      const nextOrdinal = current.reduce((max, row) => Math.max(max, row.ordinal), -1) + 1;
      const rows = added.flatMap((item, index) => {
        const conceptId = ids.get(conceptKey(item.name));
        return conceptId
          ? [
              {
                workspaceId: auth.workspaceId,
                missionId,
                conceptId,
                ordinal: nextOrdinal + index,
                reason: item.reason || "Added by you.",
                sourceQuote: null,
                sourceDocumentId: null,
              },
            ]
          : [];
      });
      if (rows.length > 0) await tx.insert(missionConcepts).values(rows).onConflictDoNothing();
    }

    // New concepts go after the ones already there. Removing a concept leaves
    // its ordinal unused: order is all that matters, and gaps keep a kept
    // concept's position stable, so a renumber can never collide on the unique
    // (mission, ordinal) key mid-update.
    await recordAudit(
      auth,
      {
        action: "learning.mission_plan_edited",
        subjectType: "mission",
        subjectId: missionId,
        summary: "Edited the concept plan of a Mission",
        metadata: { kept: keep.size, added: added.length, dropped: drop.length },
      },
      tx,
    );
    return missionId;
  }).then(() => getMission(auth, missionId)) as Promise<MissionView>;
}

/** Starts a Mission: its plan is frozen and its concepts become the mock's subject. */
export async function startMission(auth: AuthContext, missionId: string): Promise<MissionView> {
  const mission = await getMission(auth, missionId);
  if (!mission) throw new MissionError("mission_not_found", "That Mission is not available.");
  if (mission.status === "active") return mission;
  if (mission.concepts.length === 0) {
    throw new MissionError("no_concepts", "A Mission needs at least one concept before it starts.");
  }
  await withTransaction(async (tx) => {
    await tx
      .update(missions)
      .set({ status: "active", updatedBy: auth.userId, updatedAt: new Date() })
      .where(and(eq(missions.id, missionId), eq(missions.workspaceId, auth.workspaceId)));
    await recordAudit(
      auth,
      {
        action: "learning.mission_started",
        subjectType: "mission",
        subjectId: missionId,
        summary: "Started working on a Mission",
        metadata: { conceptCount: mission.concepts.length, dated: mission.dueOn !== null },
      },
      tx,
    );
  });
  return (await getMission(auth, missionId))!;
}

/** The day the Mission must be performed: a draft may change it without touching its plan. */
export async function updateMissionDueDate(auth: AuthContext, missionId: string, dueOn: string | null): Promise<void> {
  if (dueOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
    throw new MissionError("invalid_goal", "The date must be a real day, like 2026-12-01.");
  }
  const [row] = await db
    .update(missions)
    .set({ dueOn, updatedBy: auth.userId, updatedAt: new Date() })
    .where(and(eq(missions.id, missionId), eq(missions.workspaceId, auth.workspaceId)))
    .returning({ id: missions.id });
  if (!row) throw new MissionError("mission_not_found", "That Mission is not available.");
}
