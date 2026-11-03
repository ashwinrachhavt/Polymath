/**
 * The assessor: the engine's Assessor port over eve eval sessions.
 *
 * One dedicated eve profile judges one Candidate through three tools —
 * `orchestrator_eval_read` (bounded state), `orchestrator_eval` (the
 * judgment), and `orchestrator_eval_decide` (the final decision, with
 * Mercury Decide's calibration beside Eve's judgment). The port's `request`
 * enqueues an effect only; the durable work happens in `handleAssessment`
 * after commit, so a crash between eval start and session start loses
 * nothing (spec §4, the one-writer invariant).
 *
 * Judgment state is deliberately thin: what the assessor keeps between the
 * session's tool calls is the judgment itself and the session's run id —
 * everything the judgment acted on is re-read from the domain store, so a
 * restarted process degrades honestly (the session is told its judgment was
 * lost, and the expiry path is the backstop) instead of deciding from stale
 * memory.
 */
import type { AuthContext } from "@/domains/identity/resolve";
import type { Engine } from "../core/engine";
import { said, type Reason } from "../core/reasons";
import type { AcceptMode } from "../core/model";
import type { AssessmentOutcome, Candidate, Repositories } from "../core/ports";
import type { PolicyRule } from "../core/policy/gate";
import { Later } from "../effects/later";
import { boundCandidate, type BoundedCandidate } from "./bounds";
import { assembleCandidateBrief } from "./prompt";
import { EVAL_TOOLS, type EveForAssessor } from "./eve";
import { admitProbabilityOf, decideRequest, escalationReasonOf, DECIDE_ADMIT_QUESTION } from "./decide";
import { resolveAssessmentDecision, type AssessmentDecisionRecord, type DecideVerdict } from "../decide/record";
import type { DecideClient } from "../decide/client";
import type { AssessorConfig } from "./config";

/** The Engine slice the assessor drives: the sole writer, behind it. */
export type EngineForAssessor = Pick<Engine, "candidate" | "candidateDelivered" | "decide">;

export { ASSESSOR_DEFAULTS, parseAssessorConfig, type AssessorConfig } from "./config";

/** The effect payload that starts (or replays) one eval session. */
export interface AssessmentPayload {
  assessmentId: string;
  threadKey: string;
}

/** The policy slice the brief renders, from the same settings the gate reads. */
interface PolicyView {
  rules: PolicyRule[];
  mode: AcceptMode;
}

/**
 * Everything the assessor borrows from its host. `repos` is the read side of
 * the domain store (or MemoryRepositories in specs); `engine` is the sole
 * writer behind it. The host owns transaction edges: `flush` persists the
 * domain writes a handler made, and `afterCommit` schedules work that must
 * not run inside one — the cancel of a stale session after an expiry.
 */
export interface AssessorHost {
  workspaceId: string;
  repos: Repositories;
  engine: EngineForAssessor;
  effects: {
    enqueue(
      effect:
        | { kind: "assessment"; key: string; payload: Record<string, unknown> }
        | { kind: "reap"; key: string; availableAt: string },
    ): void;
  };
  eve: EveForAssessor;
  /** The Mercury Decide client, or null when the seam is not configured. */
  decide: DecideClient | null;
  afterCommit(work: () => Promise<void>): void;
  flush(): Promise<void>;
  /**
   * Runs after a decision's effects are durable: the launch effect this
   * decision enqueued drains here, because the eval tools run inside the
   * specialist's process — no send-path drain ever follows them, and a
   * decision that stops at enqueue strands its ticket's launch until cron.
   */
  afterDecision?(): Promise<void>;
  auth(): Promise<AuthContext>;
  policyView(): PolicyView;
  config: AssessorConfig;
}

/** The judgment the eval session records through `orchestrator_eval`. */
export interface EvalJudgmentInput {
  outcome: "accept" | "ignore" | "stop" | "unavailable";
  reason: string;
  rules?: string[];
  title?: string;
  scope?: string;
  name?: string;
  note?: string;
  acknowledgement?: string;
  ticketId?: string;
}

export type EvalReadPart = "thread" | "triggers" | "tickets" | "rules";

/** What a tool call returns to the eval session: a result, or an honest refusal. */
export type EvalToolResult =
  | { part: EvalReadPart; content: string }
  | { recorded: true; next: string }
  | {
      outcome: AssessmentDecisionRecord["final"]["kind"];
      decidedBy: AssessmentDecisionRecord["final"]["decidedBy"];
      escalation?: string;
      decide: { admitProbability: number; model: string } | null;
    }
  | { error: string };

interface EvalTools {
  read(assessmentId: string, part: EvalReadPart): Promise<EvalToolResult>;
  judge(assessmentId: string, judgment: EvalJudgmentInput): Promise<EvalToolResult>;
  decide(assessmentId: string): Promise<EvalToolResult>;
}

export interface SuperagentAssessor {
  request(candidate: Candidate): void;
  release(assessmentId: string): void;
  /** The expiry tick the engine schedules when a candidate is delivered. */
  scheduleReap(assessmentId: string, deadlineAt: string): void;
  /** The assessment effect's handler. */
  handleAssessment(payload: AssessmentPayload): Promise<void>;
  /** The eval tools an eval session's calls resolve to. */
  tools: EvalTools;
}

interface KeptEval {
  threadKey: string;
  agentRunId?: string;
  judgment?: EvalJudgmentInput;
  finalizing?: boolean;
}

/** How long a capacity-deferred assessment waits before its next drain. */
const EVAL_RETRY_MS = 5_000;

const STALE_EVAL = "this evaluation is no longer running; its state is stored — do not judge it again";

export function createSuperagentAssessor(host: AssessorHost): SuperagentAssessor {
  const { workspaceId, repos, config } = host;
  /** The thin between-tool-calls state, per assessment. */
  const kept = new Map<string, KeptEval>();

  const triggerOf = (id: string) => repos.triggers.get(id);

  /** The candidate an assessment id names, rebuilt fresh from the domain store. */
  const candidateFor = (assessmentId: string): Candidate | undefined => {
    const held = repos.threads.active().find((thread) => thread.evaluating?.id === assessmentId);
    if (!held?.evaluating) return undefined;
    return host.engine.candidate(held.evaluating.triggerIds[0]!);
  };

  /** One Mercury Decide call over the bounded state, or null when the seam did not run. */
  const calibrate = async (bounded: BoundedCandidate): Promise<DecideVerdict | null> => {
    const client = host.decide;
    if (!client) return null;
    try {
      const result = await client.decide(decideRequest(bounded));
      return { admitProbability: admitProbabilityOf(result), question: DECIDE_ADMIT_QUESTION, model: result.model };
    } catch (cause) {
      // A Decide failure never hard-stops admission: Eve decides, and the
      // record's `decide: null` shows the seam did not run (spec §9).
      console.error("[superagent-assessor] the Mercury Decide call failed; Eve decides alone", cause);
      return null;
    }
  };

  const outcomeFrom = (
    record: AssessmentDecisionRecord,
    judgment: EvalJudgmentInput,
    assessmentId: string,
  ): AssessmentOutcome & { assessmentId?: string } => {
    const escalated = record.final.decidedBy === "escalated";
    const reason: string | Reason = escalated
      ? escalationReasonOf(record, config.admitThreshold)[0]!
      : said(judgment.reason);
    const audit = { decision: record };
    const common = { reason, assessmentId, audit };
    switch (record.final.kind) {
      case "accept":
      // The engine maps an accept onto an ended ticket to a reopen decision;
      // the Outcome it expects for either is still an accept.
      case "reopen":
        return {
          kind: "accept",
          title: judgment.title!,
          scope: judgment.scope!,
          ...common,
          ...(judgment.rules?.length ? { rules: judgment.rules } : {}),
          ...(judgment.name ? { name: judgment.name } : {}),
          ...(judgment.note ? { note: judgment.note } : {}),
          ...(judgment.acknowledgement ? { acknowledgement: judgment.acknowledgement } : {}),
        };
      case "stop":
        return { kind: "stop", ticketId: judgment.ticketId!, ...common };
      case "ignore":
        return { kind: "ignore", ...common };
      case "unavailable":
        return { kind: "unavailable", ...common };
    }
  };

  const assessor: SuperagentAssessor = {
    request(candidate: Candidate): void {
      host.effects.enqueue({
        kind: "assessment",
        key: candidate.assessmentId,
        payload: { assessmentId: candidate.assessmentId, threadKey: candidate.thread.key } satisfies AssessmentPayload,
      });
    },

    scheduleReap(assessmentId: string, deadlineAt: string): void {
      // The deadline's observer: a reap effect due exactly at it, coalesced on
      // the assessment id. When it fires, the handler ticks the workspace and
      // the engine expires whatever eval is past its deadline; a decided or
      // reassessed assessment's reap is a no-op tick.
      host.effects.enqueue({ kind: "reap", key: assessmentId, availableAt: deadlineAt });
    },

    release(assessmentId: string): void {
      const keptEval = kept.get(assessmentId);
      kept.delete(assessmentId);
      if (!keptEval || keptEval.finalizing || !keptEval.agentRunId) return;
      // The eval expired or was reassessed: its session is stale. Cancel it
      // after commit — never inside the engine's transaction.
      const { agentRunId } = keptEval;
      host.afterCommit(async () => {
        try {
          await host.eve.cancel({ workspaceId, auth: await host.auth(), agentRunId });
        } catch (cause) {
          // A cancel that fails is logged, not fatal — the session ends on its own deadline.
          console.error(`[superagent-assessor] the cancel of eval session ${agentRunId} failed`, cause);
        }
      });
    },

    async handleAssessment(payload: AssessmentPayload): Promise<void> {
      const thread = repos.threads.get(payload.threadKey);
      const evaluation = thread?.evaluating;
      if (!thread || !evaluation || evaluation.id !== payload.assessmentId) return; // finished or reassessed before its drain
      const runningEvals = repos.threads
        .active()
        .filter((active) => active.evaluating?.delivered && active.evaluating.id !== evaluation.id).length;
      if (runningEvals >= config.maxConcurrent)
        throw new Later(EVAL_RETRY_MS, `${config.maxConcurrent} eval sessions already run`);

      const candidate = host.engine.candidate(evaluation.triggerIds[0]!);
      if (!candidate) return;

      // A replayed effect (a drained pass that started the session and died
      // before recording delivered) must not start a second session.
      const prior = await host.eve.lastEval({ workspaceId, assessmentId: payload.assessmentId });
      if (!prior) {
        const { rules, mode } = host.policyView();
        const brief = assembleCandidateBrief(candidate, { rules, mode }, { triggerOf });
        const { agentRunId } = await host.eve.start({
          workspaceId,
          auth: await host.auth(),
          assessmentId: payload.assessmentId,
          objective: brief,
          profileName: config.profileName,
          estimateUsd: config.estimateUsd,
          allowedTools: [...EVAL_TOOLS],
        });
        kept.set(payload.assessmentId, { threadKey: payload.threadKey, agentRunId });
      }
      host.engine.candidateDelivered(payload.assessmentId);
      await host.flush();
    },

    tools: {
      read: async (assessmentId, part): Promise<EvalToolResult> => {
        const candidate = candidateFor(assessmentId);
        if (!candidate) return { error: STALE_EVAL };
        const bounded = boundCandidate(candidate, triggerOf);
        switch (part) {
          case "thread":
            return {
              part,
              content: [
                `WorkThread ${bounded.threadKey} (${bounded.thread.source}:${bounded.thread.id}); candidate ${bounded.assessmentId}, strength ${bounded.strength}, policy ${bounded.policyVersion}.`,
                `Tickets on this thread: ${bounded.ticketTotal} (${bounded.droppedTickets} not shown).`,
              ].join(" "),
            };
          case "triggers":
            return {
              part,
              content: bounded.triggers
                .map(
                  (trigger) =>
                    `[${trigger.id}] at ${trigger.at} by ${trigger.actor.source}:${trigger.actor.id}${trigger.human ? "" : " (automated)"}${trigger.addressed ? `, ${trigger.addressed}` : ""}\n${trigger.text}`,
                )
                .join("\n\n"),
            };
          case "tickets": {
            if (!bounded.tickets.length) return { part, content: "no tickets on this thread" };
            const dropped = bounded.droppedTickets ? ` (${bounded.droppedTickets} more not shown)` : "";
            return {
              part,
              content:
                bounded.tickets
                  .map((ticket) => {
                    const state = ticket.ended ? `ended (${ticket.outcome})` : "open";
                    const report = ticket.report
                      ? `; latest report: ${ticket.report.state} — ${ticket.report.summary}`
                      : "";
                    const origin = ticket.originText ? `; request that started it: ${ticket.originText}` : "";
                    return `[${ticket.id}] ${ticket.title} — ${state}${report}${origin}`;
                  })
                  .join("\n") + dropped,
            };
          }
          case "rules": {
            const rules = host.policyView().rules;
            if (!rules.length) return { part, content: "no admission rules are enabled" };
            return { part, content: rules.map((rule) => `[${rule.id}] ${rule.name}: ${rule.instruction}`).join("\n") };
          }
        }
      },

      judge: async (assessmentId, judgment): Promise<EvalToolResult> => {
        const candidate = candidateFor(assessmentId);
        if (!candidate) return { error: STALE_EVAL };
        const keptEval: KeptEval = kept.get(assessmentId) ?? { threadKey: candidate.thread.key };
        if (keptEval.finalizing) return { error: "this evaluation is already decided — do not judge it again" };
        if (!judgment.reason?.trim()) return { error: "a judgment names a reason" };
        switch (judgment.outcome) {
          case "accept":
            if (!judgment.title?.trim() || !judgment.scope?.trim())
              return { error: "an accept names a short title and a concrete scope" };
            break;
          case "stop":
            if (!judgment.ticketId?.trim()) return { error: "a stop names the ticket to stop" };
            break;
          case "ignore":
          case "unavailable":
            break;
        }
        kept.set(assessmentId, { ...keptEval, judgment });
        return { recorded: true, next: "finish with orchestrator_eval_decide" };
      },

      decide: async (assessmentId): Promise<EvalToolResult> => {
        const candidate = candidateFor(assessmentId);
        if (!candidate) return { error: STALE_EVAL };
        const keptEval = kept.get(assessmentId);
        if (!keptEval?.judgment)
          return { error: "no judgment is recorded for this evaluation — record one with orchestrator_eval first" };
        const bounded = boundCandidate(candidate, triggerOf);
        const verdict = await calibrate(bounded);
        const record = resolveAssessmentDecision(
          {
            outcome: keptEval.judgment.outcome,
            ...(keptEval.judgment.rules ? { rules: keptEval.judgment.rules } : {}),
            reason: keptEval.judgment.reason,
          },
          verdict,
          { admitThreshold: config.admitThreshold },
        );
        const outcome = outcomeFrom(record, keptEval.judgment, assessmentId);
        keptEval.finalizing = true;
        try {
          host.engine.decide(candidate.triggers[0]!.id, outcome);
        } catch (cause) {
          keptEval.finalizing = false; // the domain refused — the session may correct its judgment
          return {
            error: `the engine refused the decision: ${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }
        await host.flush();
        // The launch effect is durable now; drain it in this process (the
        // specialist's), where no send-path drain will ever tick.
        await host.afterDecision?.();
        return {
          outcome: record.final.kind,
          decidedBy: record.final.decidedBy,
          ...(record.final.escalation ? { escalation: record.final.escalation } : {}),
          decide: record.decide
            ? { admitProbability: record.decide.admitProbability, model: record.decide.model }
            : null,
        };
      },
    },
  };

  return assessor;
}
