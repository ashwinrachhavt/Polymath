import type { TurnLane, TurnRoute } from "./turn-routing";

/*
 * What each lane decides about a turn. The router names the lane; this table
 * is the decision. Pure data plus one function, so a spec can pin it.
 *
 * One agent loop (owner decision 2026-11-13): the lane loads its skill (the
 * `skill` text, sent only on that lane's turns) and a small tool subset.
 * Sub-agents exist only for heavy, context-hungry work: research, and a deep
 * sweep of the owner's library. They run as copies of the agent in their own
 * server-side eve session (durable, cancellable with the turn, inside the
 * run's budget) and return a condensed result, so the conversation never
 * carries their pages and passages.
 *
 * - `model`: "small" runs the turn on the small model; "main" on the run's
 *   frozen model.
 * - `tools`: the only tools the model is shown. Library tools join only when
 *   the router says the turn needs the owner's material: a general question
 *   never sees `documents_search`, so it cannot search out of habit.
 * - `maxSteps` / `maxInputTokens`: hard caps for one turn. At either cap the
 *   model may not call tools and must answer with what it has.
 */

export type LanePolicy = {
  model: "small" | "main";
  tools: readonly string[];
  /** Added when the route says the owner's library is needed. */
  libraryTools: readonly string[];
  maxSteps: number;
  maxInputTokens: number;
  /** The lane's skill: what this turn is and how to do it, injected next to the person's message. */
  skill: string;
};

/** The tool that starts a sub-agent (a copy of this agent with its own small context). */
export const DELEGATE_TOOL = "agent";

/** eve's catalog tools: the only way to reach the provider gateway's connected-account tools. */
const CATALOG_TOOLS = ["eve__search", "eve__tool"] as const;

const LIBRARY_TOOLS = ["documents_search", "wiki_read"] as const;
const WEB_TOOLS = ["web_search", "web_fetch"] as const;
const TASK_TOOLS = ["tasks_read", "tasks_recent"] as const;

/** Per-turn hard caps from the owner's brief: 6 steps and about 30k input tokens. */
const TURN_STEP_CAP = 6;
export const TURN_INPUT_TOKEN_CAP = 30_000;

const LANE_POLICY: Record<TurnLane, LanePolicy> = {
  quick: {
    model: "small",
    tools: [],
    libraryTools: [],
    maxSteps: 1,
    maxInputTokens: 8_000,
    skill: "Small talk or an acknowledgement: reply in one or two sentences. Use no tools.",
  },
  answer: {
    model: "main",
    tools: [...WEB_TOOLS, ...TASK_TOOLS],
    libraryTools: [...LIBRARY_TOOLS, "records_browse", "notebook_open", DELEGATE_TOOL],
    maxSteps: 4,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    skill:
      "Answer directly. Call a tool only when the answer needs evidence you do not have; one search per intent. For a question that needs a sweep across many of the owner's documents, give the `agent` sub-agent a self-contained brief and answer from what it returns.",
  },
  research: {
    model: "main",
    tools: [DELEGATE_TOOL],
    libraryTools: [],
    maxSteps: 3,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    skill:
      "Research: give the `agent` sub-agent a self-contained brief (the question, what to find, and that it must return a condensed brief with sources). Then write the answer from its brief, naming sources.",
  },
  tutor: {
    model: "main",
    tools: [...WEB_TOOLS, "diagram"],
    libraryTools: [...LIBRARY_TOOLS],
    maxSteps: 4,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    skill:
      "Teaching, Socratic by default: find out what the person already knows, explain one step at a time with a concrete example, and end with one question that checks understanding. When they give an answer, diagnose how they reached it before correcting it. Work out any arithmetic step by step and show it.",
  },
  draft: {
    model: "main",
    tools: ["web_fetch", "records_browse", "zettels_propose", "notion_propose_update"],
    libraryTools: [...LIBRARY_TOOLS],
    maxSteps: 4,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    skill:
      "Drafting: write the draft from the conversation and what you can read. A draft is a draft: nothing is sent or saved unless a propose tool says it is waiting for approval.",
  },
  operate: {
    model: "main",
    tools: [
      ...TASK_TOOLS,
      "tasks_propose",
      "notion_propose_update",
      "zettels_propose",
      "artifacts_propose_revision",
      "calendar_conflicts",
      "calendar_conflict_propose",
      "crm_propose_contacts",
      "github_triage_propose",
      "meeting_debrief",
      "connector_actions",
      "wiki_ingest",
      "wiki_lint",
      ...CATALOG_TOOLS,
    ],
    libraryTools: [...LIBRARY_TOOLS],
    maxSteps: 4,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    skill:
      "An action: use the matching propose tool, or a connected account's tool found with eve__search. Report what was proposed and where it waits; never claim an action happened unless a tool result says so.",
  },
  explain_change: {
    model: "main",
    tools: ["web_fetch", ...CATALOG_TOOLS],
    libraryTools: [],
    maxSteps: 4,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    skill:
      "Explaining a code change: work from the diff or the files you actually read; say what you could not inspect.",
  },
};

/** The two sub-agents: research, and a deep sweep of the owner's library. */
const SUB_AGENT_POLICY = {
  research: {
    model: "main",
    tools: [...WEB_TOOLS, "research_deepen"],
    libraryTools: [...LIBRARY_TOOLS],
    maxSteps: TURN_STEP_CAP,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    skill:
      "You are a research sub-agent. Gather evidence for the brief: search, then read the best pages. Return a condensed brief of at most 300 words: findings with the source (title and URL) for each.",
  },
  library: {
    model: "main",
    tools: [...LIBRARY_TOOLS, "records_browse", "notebook_open"],
    libraryTools: [],
    maxSteps: TURN_STEP_CAP,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    skill:
      "You are a library sub-agent. Search the owner's documents for the brief with a few different queries. Return at most 300 words: what the documents say, each point with its document title. Say plainly what you did not find.",
  },
} as const satisfies Record<string, LanePolicy>;

/**
 * The policy for one model call: the root's lane, or, inside a sub-agent
 * (which has no `agent` tool of its own), the research or library sub-agent.
 */
export function policyFor(route: TurnRoute, inSubAgent: boolean): LanePolicy {
  if (inSubAgent) return route.lane === "research" ? SUB_AGENT_POLICY.research : SUB_AGENT_POLICY.library;
  return LANE_POLICY[route.lane];
}

/** The tool names the model may see this call. */
export function visibleTools(policy: LanePolicy, route: TurnRoute): ReadonlySet<string> {
  return new Set([...policy.tools, ...(route.needsLibrary ? policy.libraryTools : [])]);
}
