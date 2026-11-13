import { readFileSync } from "node:fs";
import { defineDynamic, defineTool } from "eve/tools";
import artifacts_propose_revision from "./artifacts_propose_revision";
import calendar_conflict_propose from "./calendar_conflict_propose";
import calendar_conflicts from "./calendar_conflicts";
import connector_actions from "./connector_actions";
import crm_propose_contacts from "./crm_propose_contacts";
import diagram from "./diagram";
import documents_search from "./documents_search";
import github_triage_propose from "./github_triage_propose";
import meeting_debrief from "./meeting_debrief";
import notebook_open from "./notebook_open";
import notion_propose_update from "./notion_propose_update";
import records_browse from "./records_browse";
import research_deepen from "./research_deepen";
import tasks_propose from "./tasks_propose";
import tasks_read from "./tasks_read";
import tasks_recent from "./tasks_recent";
import web_fetch from "./web_fetch";
import web_search from "./web_search";
import wiki_ingest from "./wiki_ingest";
import wiki_lint from "./wiki_lint";
import wiki_read from "./wiki_read";
import zettels_propose from "./zettels_propose";

/*
 * Recorded tool outputs for the agent eval (eve/polymath/evals). Inert
 * everywhere else.
 *
 * eve's own tool stubs did not reach these tools in 0.76.3 (the session
 * accepted the rules, reported no failure, and matched none), so the eval
 * replays recordings here instead: in an eval session, every authored tool is
 * replaced by one with the same name, description, schema and deferral whose
 * result is the recording. The model sees exactly the production tool surface.
 *
 * Three gates, all required: not a production build, the eval runner set
 * POLYMATH_EVAL_FIXTURES, and the caller is the local-dev eval identity (no
 * workspace). A signed-in workspace caller never reaches a recording.
 */

const REAL_TOOLS = {
  artifacts_propose_revision,
  calendar_conflict_propose,
  calendar_conflicts,
  connector_actions,
  crm_propose_contacts,
  diagram,
  documents_search,
  github_triage_propose,
  meeting_debrief,
  notebook_open,
  notion_propose_update,
  records_browse,
  research_deepen,
  tasks_propose,
  tasks_read,
  tasks_recent,
  web_fetch,
  web_search,
  wiki_ingest,
  wiki_lint,
  wiki_read,
  zettels_propose,
} as const;

type ToolName = keyof typeof REAL_TOOLS;
/** The parts of a tool definition the replacement copies; the schemas differ per tool. */
type RealTool = {
  description: string;
  inputSchema: Parameters<typeof defineTool>[0]["inputSchema"];
  deferred?: boolean;
};
type Outcome = unknown;
type FixtureTable = {
  defaults: Partial<Record<string, Outcome>>;
  /** Keyed by the user message that starts the turn. */
  cases: Record<string, Partial<Record<string, Outcome>>>;
};

/** The eval turn being replayed; delegated copies inherit it. */
let activeCase = "";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("");
}

function loadTable(path: string): FixtureTable | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FixtureTable;
  } catch {
    return null;
  }
}

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const path = process.env.POLYMATH_EVAL_FIXTURES;
      if (process.env.NODE_ENV === "production" || !path) return null;
      if (ctx.session.auth.current?.attributes?.workspaceId !== undefined) return null;
      const table = loadTable(path);
      if (!table) return null;

      // A turn whose message is not an eval turn is a copy the measured turn
      // delegated to (its message is the brief); it replays that turn's
      // recordings. Eval cases run one at a time, so the latest is the one.
      const latestUser = ctx.messages.findLast((message) => message.role === "user");
      const text = latestUser ? textOf(latestUser.content).trim() : "";
      if (text in table.cases) activeCase = text;
      const caseKey = activeCase;
      const outcomes = { ...table.defaults, ...(table.cases[caseKey] ?? {}) };

      return Object.fromEntries(
        (Object.keys(REAL_TOOLS) as ToolName[]).map((name) => {
          const outcome = JSON.parse(JSON.stringify(outcomes[name] ?? { ok: true })) as Outcome;
          return [
            name,
            defineTool({
              description: (REAL_TOOLS[name] as RealTool).description,
              inputSchema: (REAL_TOOLS[name] as RealTool).inputSchema,
              deferred: (REAL_TOOLS[name] as RealTool).deferred,
              execute: () => outcome,
            }),
          ];
        }),
      );
    },
  },
});
