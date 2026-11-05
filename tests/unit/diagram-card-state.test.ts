import { describe, expect, it } from "vitest";
import {
  diagramCardState,
  diagramCardStates,
  isDiagramTool,
  type DiagramToolView,
} from "@/domains/diagrams/card-state";

/*
 * The diagram card's stream-level state machine (spec art_Yi8Fwsqn, "Flow and
 * states"). These are the states the card renders from, so every assertion
 * protects an observable chat behavior: a running call renders the skeleton,
 * a failed call with a retry in flight renders CORRECTING (never a fake
 * diagram), a final failure renders FAILED with the source copyable, and a
 * settled payload decodes into RENDERED — or an honest failure when the
 * payload cannot be read.
 */

const CANVAS = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "33333333-3333-4333-8333-333333333333";

const ARGS = {
  title: "Auth flow",
  mermaid: "flowchart TD\n  a --> b",
  diagramType: "flowchart",
};

const PAYLOAD = {
  ok: true,
  canvasId: CANVAS,
  artifactId: ARTIFACT,
  version: 1,
  diagramType: "flowchart",
  mermaid: ARGS.mermaid,
};

const tool = (overrides: Partial<DiagramToolView>): DiagramToolView => ({
  callId: "call-1",
  label: "diagram",
  status: "ok",
  input: ARGS,
  output: PAYLOAD,
  ...overrides,
});

describe("isDiagramTool", () => {
  it("matches the eve tool name and nothing else", () => {
    expect(isDiagramTool({ label: "diagram" })).toBe(true);
    expect(isDiagramTool({ label: "web_search" })).toBe(false);
    expect(isDiagramTool({ label: "diagram_tool" })).toBe(false);
  });
});

describe("diagramCardState", () => {
  it("returns null for a non-diagram tool", () => {
    expect(diagramCardState(tool({ label: "web_search" }), "none")).toBeNull();
  });

  it("renders a running call as RENDERING with the tool's title", () => {
    expect(diagramCardState(tool({ status: "running", output: undefined }), "none")).toEqual({
      state: "rendering",
      title: "Auth flow",
      diagramType: "flowchart",
    });
  });

  it("renders a running call without args as an untitled skeleton, not a crash", () => {
    expect(diagramCardState(tool({ status: "running", input: undefined, output: undefined }), "none")).toEqual({
      state: "rendering",
      title: null,
      diagramType: null,
    });
  });

  it("renders a settled call as RENDERED with the decoded payload", () => {
    expect(diagramCardState(tool({}), "none")).toEqual({
      state: "rendered",
      title: "Auth flow",
      superseded: false,
      output: {
        canvasId: CANVAS,
        artifactId: ARTIFACT,
        version: 1,
        diagramType: "flowchart",
        mermaid: ARGS.mermaid,
      },
    });
  });

  it("renders a final failure as FAILED with the attempted source for hand-fixing", () => {
    const failed = tool({ status: "error", detail: "tool_error", output: { ok: false, error: "the diagram has about 80 nodes; the cap is 60." } });
    expect(diagramCardState(failed, "none")).toEqual({
      state: "failed",
      title: "Auth flow",
      error: "the diagram has about 80 nodes; the cap is 60. (tool_error)",
      mermaid: ARGS.mermaid,
      superseded: false,
    });
  });

  it("renders a failed call with a retry in flight as CORRECTING with the parser error", () => {
    const failed = tool({ callId: "call-1", status: "error", detail: "tool_error", output: { ok: false, error: "unclosed code fence: the mermaid argument opened ``` but never closed it." } });
    expect(diagramCardState(failed, "pending")).toEqual({
      state: "correcting",
      title: "Auth flow",
      parserError: "unclosed code fence: the mermaid argument opened ``` but never closed it.",
      superseded: true,
    });
  });

  it("reads the {ok:false} error envelope even when the fold marked the frame ok", () => {
    // The eve tool returns refusals as result values, so the action.result
    // frame can settle "ok" with an error envelope as its payload — the call
    // completed, the diagram does not exist.
    expect(diagramCardState(tool({ output: { ok: false, error: "no canvas with this id in this workspace" } }), "none")).toEqual({
      state: "failed",
      title: "Auth flow",
      error: "no canvas with this id in this workspace",
      mermaid: ARGS.mermaid,
      superseded: false,
    });
  });

  it("renders an undecodable success payload as FAILED, never a half-filled diagram", () => {
    const junk = tool({ output: { ok: true, canvasId: "junk" } });
    expect(diagramCardState(junk, "none")).toEqual({
      state: "failed",
      title: "Auth flow",
      error: "The diagram result could not be read from the stream.",
      mermaid: ARGS.mermaid,
      superseded: false,
    });
  });

  it("marks a failure superseded when a later attempt settled", () => {
    const failed = tool({ status: "error", detail: "tool_error", output: { ok: false, error: "parse failed" } });
    expect(diagramCardState(failed, "settled")).toMatchObject({ state: "failed", superseded: true });
  });
});

describe("diagramCardStates", () => {
  it("skips non-diagram tools entirely", () => {
    const tools = [
      tool({ callId: "call-0", label: "web_search", status: "ok", output: { results: [] } }),
      tool({ callId: "call-1", status: "ok" }),
    ];
    expect(diagramCardStates(tools).map(({ callId }) => callId)).toEqual(["call-1"]);
  });

  it("flips an errored attempt to CORRECTING while the retry is running", () => {
    const tools = [
      tool({ callId: "call-1", status: "error", detail: "tool_error", output: { ok: false, error: "parse failed" } }),
      tool({ callId: "call-2", status: "running", output: undefined }),
    ];
    const cards = diagramCardStates(tools);
    expect(cards[0].card).toMatchObject({ state: "correcting" });
    expect(cards[1].card).toMatchObject({ state: "rendering" });
  });

  it("keeps the first attempt as superseded history once the retry settles", () => {
    const tools = [
      tool({ callId: "call-1", status: "error", detail: "tool_error", output: { ok: false, error: "parse failed" } }),
      tool({ callId: "call-2", status: "ok", output: { ...PAYLOAD, version: 1 } }),
    ];
    const cards = diagramCardStates(tools);
    expect(cards[0].card).toMatchObject({ state: "failed", superseded: true });
    expect(cards[1].card).toMatchObject({ state: "rendered" });
  });

  it("renders a second consecutive failure as FAILED, never a fake diagram", () => {
    const tools = [
      tool({ callId: "call-1", status: "error", detail: "tool_error", output: { ok: false, error: "parse failed once" } }),
      tool({ callId: "call-2", status: "error", detail: "tool_error", output: { ok: false, error: "parse failed twice" } }),
    ];
    const cards = diagramCardStates(tools);
    expect(cards[0].card).toMatchObject({ state: "failed", superseded: true });
    expect(cards[1].card).toMatchObject({ state: "failed", superseded: false, error: "parse failed twice (tool_error)" });
  });

  it("keeps a refinement card as history behind the newer version", () => {
    const tools = [
      tool({ callId: "call-1", status: "ok", output: PAYLOAD }),
      tool({ callId: "call-2", status: "ok", output: { ...PAYLOAD, version: 2, mermaid: "flowchart TD\n  a --> b --> c" } }),
    ];
    const cards = diagramCardStates(tools);
    expect(cards[0].card).toMatchObject({ state: "rendered", superseded: true });
    expect(cards[1].card).toMatchObject({ state: "rendered", output: { version: 2 } });
  });
});
