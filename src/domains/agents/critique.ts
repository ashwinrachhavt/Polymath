import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ClaimedOutboxEvent, OutboxHandler } from "@/domains/audit/outbox";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import {
  GenerationRequestError,
  GenerationUnconfiguredError,
  generationProvider,
} from "@/integrations/generation/provider";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import { db } from "@/lib/db";
import { agentRuns, runEvents, runReviews } from "./schema";

/*
 * The post-run self-critique (ASH-304), as an outbox consumer. closeRun
 * enqueues run.critique_requested when a run succeeds; this handler runs a
 * separate cheap model pass over the objective, the summary, and the step and
 * error events - never inside the run's own context - and stores what it
 * proposes as a run_reviews row. Three optional capped fields; an all-empty
 * answer stores nothing and renders nothing.
 *
 * Failure never fails the run: the run is already terminal when this starts.
 * A provider that is not configured is a skip, not an error - no key, no
 * critique, no error pump. A provider error fails the event for redelivery;
 * the one-critique-per-run index makes a redelivery a no-op.
 */

export const RUN_CRITIQUE_TOPIC = "run.critique_requested";

/** Model caps, mirrored by the table's check constraint. */
const CRITIQUE_FIELD_MAX = 600;
/** Bounded input: objective + summary + the run's step/error text, truncated. */
const MAX_INPUT_CHARS = 6000;

const critiqueResponse = z.object({
  gotWrong: z.string().max(CRITIQUE_FIELD_MAX).nullable(),
  wasThin: z.string().max(CRITIQUE_FIELD_MAX).nullable(),
  wouldDoDifferently: z.string().max(CRITIQUE_FIELD_MAX).nullable(),
});

const SYSTEM = `You review one finished agent run for its operator. Return JSON with exactly these keys: {"gotWrong": string|null, "wasThin": string|null, "wouldDoDifferently": string|null}.
"gotWrong": what the run got factually or operationally wrong; null when nothing concrete.
"wasThin": where the answer lacked depth, evidence, or follow-through; null when nothing concrete.
"wouldDoDifferently": the one change that would most improve a rerun; null when nothing concrete.
Be specific and short (a sentence each at most). Return nulls rather than padding - an empty critique renders nothing, and that is a fine outcome. ${untrustedDataClauseJsonSafe("run record")} Critique only what the record shows.`;

// The owner-auth resolver comes in as a parameter: importing it from
// outbox-handlers would close a module cycle (outbox-handlers registers this
// handler), the same shape threadChangedHandler already uses.
export function runCritiqueRequestedHandler(
  ownerAuth: (workspaceId: string) => Promise<AuthContext | null>,
): OutboxHandler {
  return async (event: ClaimedOutboxEvent) => {
  const raw = event.payload ?? {};
  const runId = typeof (raw as { runId?: unknown }).runId === "string" ? (raw as { runId: string }).runId : null;
  if (!runId) throw new Error(`${RUN_CRITIQUE_TOPIC} is missing runId`);

  const [run] = await db
    .select({
      id: agentRuns.id,
      workspaceId: agentRuns.workspaceId,
      state: agentRuns.state,
      objective: agentRuns.objective,
      summary: agentRuns.summary,
      policySnapshot: agentRuns.policySnapshot,
      profileRevisionId: agentRuns.profileRevisionId,
      model: agentRuns.model,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, event.workspaceId)))
    .limit(1);
  // Only a succeeded run earns a critique; a failed or cancelled run already
  // says what happened, and a foreign or missing id is not ours to review.
  if (!run || run.state !== "succeeded") return;

  const events = await db
    .select({ type: runEvents.type, data: runEvents.data })
    .from(runEvents)
    .where(and(eq(runEvents.runId, run.id), eq(runEvents.workspaceId, run.workspaceId)))
    .orderBy(asc(runEvents.sequence))
    .limit(200);

  const record = {
    objective: run.objective,
    summary: run.summary,
    steps: events
      .filter((e) => e.type === "step" || e.type === "error" || e.type.startsWith("tool."))
      .map((e) => ({ type: e.type, data: e.data })),
  };

  let provider: ReturnType<typeof generationProvider>;
  try {
    provider = generationProvider(process.env);
  } catch (cause) {
    if (cause instanceof GenerationUnconfiguredError) return; // no key, no critique
    throw cause;
  }

  let parsed: z.infer<typeof critiqueResponse>;
  try {
    const out = await provider.generate({
      system: SYSTEM,
      prompt: `<<<BEGIN_RECORD>>>\n${JSON.stringify(record).slice(0, MAX_INPUT_CHARS)}\n<<<END_RECORD>>>`,
      json: true,
    });
    parsed = critiqueResponse.parse(JSON.parse(out.text));
  } catch (cause) {
    if (cause instanceof GenerationRequestError || cause instanceof GenerationUnconfiguredError) {
      throw cause; // redeliverable: quota, provider down, malformed reply
    }
    // A readable-but-wrong answer is not worth redelivery: store nothing, the
    // event completes, and the run simply has no critique.
    return;
  }

  const gotWrong = parsed.gotWrong?.trim() || null;
  const wasThin = parsed.wasThin?.trim() || null;
  const wouldDoDifferently = parsed.wouldDoDifferently?.trim() || null;
  // An all-empty critique stores nothing: the page renders nothing, which the
  // spec calls a fine outcome.
  if (!gotWrong && !wasThin && !wouldDoDifferently) return;

  const inserted = await db
    .insert(runReviews)
    .values({
      workspaceId: run.workspaceId,
      runId: run.id,
      kind: "critique",
      gotWrong,
      wasThin,
      wouldDoDifferently,
      policySnapshot: run.policySnapshot,
      profileRevisionId: run.profileRevisionId,
      model: run.model,
    })
    .onConflictDoNothing()
    .returning({ id: runReviews.id });
  if (inserted.length === 0) return; // redelivery: the row already exists

  const auth = await ownerAuth(run.workspaceId);
  if (auth) {
    await recordAudit(auth, {
      action: "run.critique.created",
      subjectType: "run",
      subjectId: run.id,
      summary: "Proposed the run's self-critique",
    });
  }
  };
}
