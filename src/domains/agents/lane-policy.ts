import type { TurnLane, TurnRoute } from "./turn-routing";

/*
 * What each lane decides about a turn. The router names the lane; this table
 * is the decision. Pure data plus one function, so a spec can pin it.
 *
 * - `model`: "small" runs the turn on the small model; "main" on the run's
 *   frozen model.
 * - `tools`: the only tools the model is shown. Library tools join only when
 *   the router says the turn needs the owner's material: a general question
 *   never sees `documents_search`, so it cannot search out of habit.
 * - `delegate`: the lane's gathering happens in an isolated specialist (a copy
 *   of the agent with its own small context, reached through the `agent`
 *   tool). The specialist returns a condensed result; the main conversation
 *   never carries its search results and pages.
 * - `maxSteps` / `maxInputTokens`: hard caps for one turn. At either cap the
 *   model loses its tools and must answer with what it has.
 */

export type LanePolicy = {
  model: "small" | "main";
  tools: readonly string[];
  /** Added when the route says the owner's library is needed. */
  libraryTools: readonly string[];
  delegate: boolean;
  maxSteps: number;
  maxInputTokens: number;
  /** One line telling the model what this turn is; injected next to the person's message. */
  note: string;
};

/** The tool that delegates to a specialist copy. */
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
    delegate: false,
    maxSteps: 1,
    maxInputTokens: 8_000,
    note: "Small talk or an acknowledgement: reply in one or two sentences. Use no tools.",
  },
  answer: {
    model: "main",
    tools: [...WEB_TOOLS, ...TASK_TOOLS],
    libraryTools: [...LIBRARY_TOOLS, "records_browse", "notebook_open"],
    delegate: false,
    maxSteps: 4,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    note: "Answer directly. Call a tool only when the answer needs evidence you do not have; one search per intent.",
  },
  research: {
    model: "main",
    tools: [DELEGATE_TOOL],
    libraryTools: [],
    delegate: true,
    maxSteps: 3,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    note: "Research: delegate the gathering to the `agent` specialist with a self-contained brief (the question, what to find, that it must return a condensed brief with sources). Then write the answer from its brief, naming sources.",
  },
  tutor: {
    model: "main",
    tools: [DELEGATE_TOOL, "diagram"],
    libraryTools: [],
    delegate: true,
    maxSteps: 3,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    note: "Teaching: explain step by step, check understanding with one question at the end. Teach directly from what you know; delegate to the `agent` specialist only to gather the owner's notes or current sources, with a self-contained brief.",
  },
  draft: {
    model: "main",
    tools: [DELEGATE_TOOL],
    libraryTools: [],
    delegate: true,
    maxSteps: 3,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    note: "Drafting: write the draft yourself from the conversation. Delegate to the `agent` specialist only to gather material you do not have, with a self-contained brief. Say a draft is a draft; nothing is sent.",
  },
  operate: {
    model: "main",
    tools: [DELEGATE_TOOL],
    libraryTools: [],
    delegate: true,
    maxSteps: 3,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    note: "An action: delegate it to the `agent` specialist with the exact action and details. Then report what it says happened; a proposal waits for the owner's approval, so never claim it is done.",
  },
  explain_change: {
    model: "main",
    tools: ["web_fetch", ...CATALOG_TOOLS],
    libraryTools: [],
    delegate: false,
    maxSteps: 4,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    note: "Explaining a code change: work from the diff or the files you actually read; say what you could not inspect.",
  },
};

/** What a specialist copy is shown, by the lane that delegated to it. */
const SPECIALIST_POLICY: Record<Exclude<TurnLane, "quick" | "answer" | "explain_change">, LanePolicy> = {
  research: {
    model: "main",
    tools: [...WEB_TOOLS, "research_deepen"],
    libraryTools: [...LIBRARY_TOOLS],
    delegate: false,
    maxSteps: TURN_STEP_CAP,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    note: "You are a research specialist. Gather evidence for the brief: search, then read the best pages. Return a condensed brief of at most 300 words: findings with the source (title and URL) for each.",
  },
  tutor: {
    model: "main",
    tools: [...WEB_TOOLS],
    libraryTools: [...LIBRARY_TOOLS],
    delegate: false,
    maxSteps: TURN_STEP_CAP,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    note: "You gather teaching material for the brief. Return at most 300 words: the key points, each with its source (a document title or a URL).",
  },
  draft: {
    model: "main",
    tools: ["web_fetch", "records_browse"],
    libraryTools: [...LIBRARY_TOOLS],
    delegate: false,
    maxSteps: TURN_STEP_CAP,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    note: "You gather material for a draft. Return at most 300 words of the facts and quotes the draft needs, each with its source.",
  },
  operate: {
    model: "main",
    tools: [
      ...TASK_TOOLS,
      "tasks_propose",
      "notion_propose_update",
      "zettels_propose",
      "stones_propose",
      "artifacts_propose_revision",
      "calendar_conflicts",
      "calendar_conflict_propose",
      "crm_propose_contacts",
      "github_triage_propose",
      "connector_actions",
      "wiki_ingest",
      "wiki_lint",
      "meeting_debrief",
      ...CATALOG_TOOLS,
    ],
    libraryTools: [...LIBRARY_TOOLS],
    delegate: false,
    maxSteps: TURN_STEP_CAP,
    maxInputTokens: TURN_INPUT_TOKEN_CAP,
    note: "You carry out one action as a proposal. Use the matching propose tool or a connected account's tool, then return two sentences: what was proposed or done, and where it waits. Never claim an action happened unless a tool result says so.",
  },
};

/**
 * The policy for one model call: the root's lane, or, inside a specialist copy
 * (which has no `agent` tool of its own), the specialist side of that lane.
 */
export function policyFor(route: TurnRoute, inSpecialist: boolean): LanePolicy {
  if (inSpecialist) {
    const lane = route.lane in SPECIALIST_POLICY ? (route.lane as keyof typeof SPECIALIST_POLICY) : "research";
    return SPECIALIST_POLICY[lane];
  }
  return LANE_POLICY[route.lane];
}

/** The tool names the model may see this call, in a stable order for the prompt cache. */
export function visibleTools(policy: LanePolicy, route: TurnRoute): ReadonlySet<string> {
  return new Set([...policy.tools, ...(route.needsLibrary ? policy.libraryTools : [])]);
}
