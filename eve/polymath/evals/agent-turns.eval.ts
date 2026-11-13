import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import type { EveEvalSession, EveEvalTurn } from "eve/evals";
import { httpJevClient } from "../../../src/integrations/jev/client";
import { EVAL_TURNS, type EvalTurn } from "./turns";

/*
 * Replays the eval turns against the real agent and records, per turn: input
 * tokens (all model calls, including delegated specialists), model steps, the
 * tools called (root and specialists), time to first token, cost, a judge
 * score against the turn's rubric, and whether library retrieval matched the
 * label.
 *
 * Tools always replay recorded outputs (fixtures.ts, served by the agent's
 * agent/tools/eval_fixtures.ts); the model is live. A
 * spend cap stops the run: once AGENT_EVAL_TOKEN_CAP input tokens (default
 * 1.5M) have been used, the remaining cases skip instead of spending.
 *
 * Run from eve/polymath with the provider keys in the environment:
 *   AGENT_EVAL_OUT=evals/results/after.jsonl pnpm exec eve eval agent-turns
 * then summarise with `pnpm exec tsx scripts/agent-eval-report.mts`.
 */

const OUT = process.env.AGENT_EVAL_OUT ?? join(import.meta.dirname, "results", "run.jsonl");
const TOKEN_CAP = Number(process.env.AGENT_EVAL_TOKEN_CAP ?? 1_500_000);
let spentInputTokens = 0;

type Usage = { inputTokens: number; cacheReadTokens: number; outputTokens: number };
const ZERO: Usage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

type Event = EveEvalTurn["events"][number];

function dataOf(event: Event): Record<string, unknown> {
  const data = (event as { data?: unknown }).data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function atOf(event: Event): number | null {
  const at = (event as { meta?: { at?: unknown } }).meta?.at;
  return typeof at === "string" ? Date.parse(at) : null;
}

/** The session's cumulative usage (own calls plus delegated agents) at this turn's boundary. */
function sessionUsage(turn: EveEvalTurn): Usage | null {
  for (let i = turn.events.length - 1; i >= 0; i -= 1) {
    const event = turn.events[i];
    if (!event) continue;
    if (event.type !== "session.waiting" && event.type !== "turn.waiting" && event.type !== "session.failed") continue;
    const usage = dataOf(event).usage as Partial<Usage> | undefined;
    if (usage) {
      return {
        inputTokens: usage.inputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      };
    }
  }
  return null;
}

/** Sum of this turn's root step usage; the fallback when no waiting event reported usage. */
function stepUsage(turn: EveEvalTurn): Usage {
  return turn.events
    .filter((event) => event.type === "step.completed")
    .reduce<Usage>((sum, event) => {
      const usage = (dataOf(event).usage ?? {}) as Partial<Usage>;
      return {
        inputTokens: sum.inputTokens + (usage.inputTokens ?? 0),
        cacheReadTokens: sum.cacheReadTokens + (usage.cacheReadTokens ?? 0),
        outputTokens: sum.outputTokens + (usage.outputTokens ?? 0),
      };
    }, ZERO);
}

function minus(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens - b.inputTokens,
    cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
    outputTokens: a.outputTokens - b.outputTokens,
  };
}

/** Milliseconds from the turn starting to its first streamed answer text. */
function timeToFirstToken(turn: EveEvalTurn): number | null {
  const started = turn.events.find((event) => event.type === "turn.started" || event.type === "message.received");
  const first = turn.events.find((event) => event.type === "message.appended");
  const from = started ? atOf(started) : null;
  const to = first ? atOf(first) : null;
  return from !== null && to !== null ? to - from : null;
}

type ChildFacts = { tools: string[]; steps: number };

/**
 * Tool calls and model steps inside the specialists this turn delegated to.
 * Their sessions are separate streams; each is read up to its first turn
 * boundary.
 */
async function delegatedFacts(session: EveEvalSession, turn: EveEvalTurn): Promise<ChildFacts> {
  const facts: ChildFacts = { tools: [], steps: 0 };
  for (const event of turn.events) {
    if (event.type !== "agent.started") continue;
    const child = session.agent(event as Parameters<EveEvalSession["agent"]>[0]);
    const signal = AbortSignal.timeout(20_000);
    try {
      for await (const childEvent of child.stream({ signal })) {
        if (childEvent.type === "step.completed") facts.steps += 1;
        if (childEvent.type === "actions.requested") {
          const actions = (dataOf(childEvent as Event).actions ?? []) as {
            kind?: string;
            toolName?: string;
            name?: string;
          }[];
          for (const action of actions) {
            const name = action.toolName ?? action.name;
            if (action.kind === "tool-call" && typeof name === "string") facts.tools.push(`${child.name}/${name}`);
          }
        }
        if (childEvent.type === "session.waiting" || childEvent.type === "turn.waiting") break;
      }
    } catch {
      // A child stream that cannot be read leaves its facts out; the usage
      // numbers still include it through the parent's session usage.
    }
  }
  return facts;
}

/** Jev's probability that the reply meets the rubric, or null without a key. */
async function judge(turn: EvalTurn, reply: string): Promise<number | null> {
  if (!process.env.TYPESAFE_API_KEY) return null;
  try {
    const result = await httpJevClient(process.env).systemOne({
      state: JSON.stringify({ request: turn.text, reply }),
      questions: {
        meets_rubric: {
          type: "noul",
          instructions: `Does the reply meet this rubric? ${turn.rubric} A reply that claims an action happened without evidence, or invents facts about the person, does not meet it.`,
        },
      },
    });
    const answer = result.answers.meets_rubric;
    return answer?.type === "noul" ? answer.noul : null;
  } catch {
    return null;
  }
}

const LIBRARY_TOOLS = new Set(["documents_search", "wiki_read"]);

export default EVAL_TURNS.map((spec) =>
  defineEval({
    description: `${spec.lane}: ${spec.id}`,
    tags: [spec.lane, spec.source],
    timeoutMs: 300_000,
    async test(t) {
      if (spentInputTokens >= TOKEN_CAP) t.skip(`token cap ${TOKEN_CAP} reached`);

      const [first, ...rest] = [...(spec.history ?? []), spec.text];
      let turn = await t.send(first as string);
      let before = ZERO;
      for (const next of rest) {
        before = sessionUsage(turn) ?? stepUsage(turn);
        turn = await turn.session.send(next);
      }
      const session = turn.session;
      const after = sessionUsage(turn);
      const usage = after ? minus(after, before) : stepUsage(turn);
      spentInputTokens += usage.inputTokens;

      const child = await delegatedFacts(session, turn);
      const rootTools = turn.toolCalls.map((call) => call.name);
      const tools = [...rootTools, ...child.tools];
      const retrieved = tools.some((name) => LIBRARY_TOOLS.has(name.split("/").pop() ?? name));
      const retrievalOk = spec.library === "optional" ? true : spec.library === "required" ? retrieved : !retrieved;
      const reply = turn.message ?? "";
      const score = await judge(spec, reply);
      const rootSteps = turn.events.filter((event) => event.type === "step.completed").length;
      const models = [
        ...new Set(
          turn.events
            .filter((event) => event.type === "step.started")
            .map((event) => String(dataOf(event).modelId ?? "")),
        ),
      ];

      const row = {
        id: spec.id,
        lane: spec.lane,
        library: spec.library,
        status: turn.status,
        inputTokens: usage.inputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        outputTokens: usage.outputTokens,
        steps: rootSteps + child.steps,
        rootSteps,
        tools,
        models,
        ttftMs: timeToFirstToken(turn),
        retrieved,
        retrievalOk,
        judge: score,
        replyChars: reply.length,
        reply: reply.slice(0, 600),
        debugOutputs: process.env.AGENT_EVAL_DEBUG
          ? turn.toolCalls.map((call) => ({
              name: call.name,
              status: call.status,
              output: JSON.stringify(call.output).slice(0, 200),
            }))
          : undefined,
      };
      mkdirSync(dirname(OUT), { recursive: true });
      appendFileSync(OUT, `${JSON.stringify(row)}\n`);
      t.log(JSON.stringify({ ...row, reply: undefined }));

      t.succeeded();
      t.check(
        retrievalOk,
        satisfies((value) => value === true, "retrieval matches the label"),
      ).soft();
    },
  }),
);
