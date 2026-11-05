import { decodeDiagramToolOutput, type DecodedDiagramToolOutput } from "@/domains/agents/stream-contract";
import { DIAGRAM_TYPES, type DiagramType } from "./types";

/*
 * The diagram card's stream-level state machine (spec art_Yi8Fwsqn, "Flow and
 * states"). One card per `diagram` tool call; the state derives purely from
 * the frames the client saw, so a reconnect replays to the same state.
 *
 * RENDERING  — the call is running; the skeleton shows the tool's title.
 * CORRECTING — the call failed while a newer diagram attempt is still open:
 *              the agent's one-shot self-correction pass, shown with the
 *              first attempt's parser error. Never more than one automatic
 *              retry, so this state is terminal as history once the newer
 *              attempt settles.
 * RENDERED   — the call succeeded and its payload decoded; the card can run
 *              the client render pipeline.
 * FAILED     — the call failed with nothing newer to show: parser error text,
 *              the attempted source (copyable), no fake diagram.
 */

/** The streamed tool entry a card renders from (the ChatState["tools"] shape). */
export type DiagramToolView = {
  callId: string;
  label: string;
  status: "running" | "ok" | "error";
  detail?: string;
  /** The call's arguments (title, mermaid, diagramType, targetCanvasId?) — kept after settle by mergeTool. */
  input?: unknown;
  /** The result payload once settled: DiagramToolPayload, or an {ok:false, error} envelope. */
  output?: unknown;
};

export type DiagramCardState =
  | { state: "rendering"; title: string | null; diagramType: DiagramType | null }
  | { state: "correcting"; title: string | null; parserError: string; superseded: boolean }
  | { state: "rendered"; title: string | null; output: DecodedDiagramToolOutput; superseded: boolean }
  | { state: "failed"; title: string | null; error: string; mermaid: string | null; superseded: boolean };

/** How a newer diagram attempt relates to this one (drives correcting vs failed). */
export type LaterAttempt = "none" | "pending" | "settled";

/** The eve tool's runtime name is the filename slug (eve tools/definition.d.ts). */
const DIAGRAM_TOOL_NAME = "diagram";

export function isDiagramTool(tool: { label: string }): boolean {
  return tool.label === DIAGRAM_TOOL_NAME;
}

type ToolArgs = {
  title?: unknown;
  mermaid?: unknown;
  diagramType?: unknown;
  targetCanvasId?: unknown;
};

function argsOf(tool: DiagramToolView): ToolArgs {
  return (typeof tool.input === "object" && tool.input !== null ? tool.input : {}) as ToolArgs;
}

function titleOf(args: ToolArgs): string | null {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  return title.length > 0 ? title : null;
}

function diagramTypeOf(args: ToolArgs): DiagramType | null {
  const value = typeof args.diagramType === "string" ? args.diagramType : "";
  return (DIAGRAM_TYPES as readonly string[]).includes(value) ? (value as DiagramType) : null;
}

/**
 * The failure for a settled call, or null when it succeeded with a decodable
 * payload: the message to show, plus the frame's error code when the fold
 * carried one. The FAILED card shows both — message and code — while the
 * CORRECTING card shows the parser message alone: it is the text the agent
 * self-corrects from, and the code is noise there.
 */
function failureOf(tool: DiagramToolView): { message: string; detail: string | null } | null {
  const output = typeof tool.output === "object" && tool.output !== null ? tool.output : null;
  if (output) {
    const envelope = output as { ok?: unknown; error?: unknown };
    if (envelope.ok === false) {
      const error = typeof envelope.error === "string" && envelope.error.trim().length > 0 ? envelope.error : null;
      const detail =
        tool.status === "error" && typeof tool.detail === "string" && tool.detail.length > 0 ? tool.detail : null;
      return { message: error ?? "The diagram call was refused.", detail };
    }
  }
  if (tool.status === "error") {
    return {
      message: typeof tool.detail === "string" && tool.detail.length > 0 ? tool.detail : "The diagram call failed.",
      detail: null,
    };
  }
  return null;
}

/**
 * The card state for one diagram tool call, or null for a non-diagram tool.
 *
 * `laterAttempt` distinguishes the one-shot self-correction (a newer diagram
 * attempt exists) from a final failure: the correcting state exists only
 * while the retry story is live, and a superseded failure stays in the
 * transcript as history — the card lineage, one call per card.
 */
export function diagramCardState(tool: DiagramToolView, laterAttempt: LaterAttempt): DiagramCardState | null {
  if (!isDiagramTool(tool)) return null;
  const args = argsOf(tool);
  const title = titleOf(args);
  const superseded = laterAttempt !== "none";

  if (tool.status === "running") {
    return { state: "rendering", title, diagramType: diagramTypeOf(args) };
  }

  const error = failureOf(tool);
  if (error !== null) {
    if (laterAttempt === "pending") {
      return { state: "correcting", title, parserError: error.message, superseded };
    }
    return {
      state: "failed",
      title,
      error: error.detail ? `${error.message} (${error.detail})` : error.message,
      mermaid: typeof args.mermaid === "string" && args.mermaid.length > 0 ? args.mermaid : null,
      superseded,
    };
  }

  const decoded = decodeDiagramToolOutput(tool.output);
  if (decoded) return { state: "rendered", title, output: decoded, superseded };
  return {
    state: "failed",
    title,
    error: "The diagram result could not be read from the stream.",
    mermaid: typeof args.mermaid === "string" && args.mermaid.length > 0 ? args.mermaid : null,
    superseded,
  };
}

/**
 * Card view-models for every diagram tool call, in arrival order. A settled
 * attempt is "pending" while any newer diagram call is still running — that
 * pending newer attempt is the agent's one-shot self-correction in flight.
 */
export function diagramCardStates(tools: DiagramToolView[]): { callId: string; card: DiagramCardState }[] {
  const diagramCalls = tools.filter(isDiagramTool);
  const cards: { callId: string; card: DiagramCardState }[] = [];
  for (const [index, tool] of diagramCalls.entries()) {
    const later = diagramCalls.slice(index + 1);
    const laterAttempt: LaterAttempt =
      later.length === 0 ? "none" : later.some((entry) => entry.status === "running") ? "pending" : "settled";
    const card = diagramCardState(tool, laterAttempt);
    if (card) cards.push({ callId: tool.callId, card });
  }
  return cards;
}
