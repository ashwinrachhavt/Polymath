import { describe, expect, it } from "vitest";
import { MAX_STEP_SOURCES, mergeStepFacts, stepFacts } from "@/domains/agents/agent-steps";
import { MAX_TOOL_PAYLOAD, frameOf, type ChatFrame } from "@/domains/agents/stream-contract";

/*
 * Frame-to-step mapping: what the step card shows for a tool call is read off
 * the call's own arguments and result, carried on the tool frame with the
 * turn it ran in. The same `stepFacts` rebuilds a recorded call after a
 * reload, so these cases pin both paths.
 */

const RUN = "00000000-0000-4000-8000-000000000001";

const toolFrame = (frames: ChatFrame[]) => {
  const frame = frames.find((entry) => entry.type === "tool");
  if (!frame || frame.type !== "tool") throw new Error("no tool frame");
  return frame;
};

describe("frameOf: tool frames carry the step", () => {
  it("a web search's running frame names its query and its turn", () => {
    const frame = toolFrame(
      frameOf(
        RUN,
        {
          type: "actions.requested",
          data: {
            turnId: "turn-1",
            stepIndex: 0,
            actions: [
              { kind: "tool-call", callId: "c1", toolName: "web_search", input: { query: "eve protocol v26" } },
            ],
          },
        },
        3,
      ),
    );
    expect(frame).toMatchObject({ callId: "c1", status: "running", turnId: "turn-1" });
    expect(frame.facts).toEqual({ kind: "search", query: "eve protocol v26", sources: [], failure: null });
  });

  it("a settled web search lists its result pages as sources, in result order", () => {
    const frame = toolFrame(
      frameOf(
        RUN,
        {
          type: "action.result",
          data: {
            turnId: "turn-1",
            status: "completed",
            result: {
              callId: "c1",
              toolName: "web_search",
              output: {
                ok: true,
                provider: "exa",
                query: "eve protocol v26",
                results: [
                  { title: "Eve docs", url: "https://www.eve.dev/docs", snippet: "…" },
                  { title: "Changelog", url: "https://github.com/eve/eve/releases", snippet: "…" },
                  { title: "Eve docs again", url: "https://www.eve.dev/docs", snippet: "duplicate page" },
                ],
              },
            },
          },
        },
        4,
      ),
    );
    expect(frame).toMatchObject({ status: "ok", turnId: "turn-1", detail: "3 results" });
    expect(frame.facts).toEqual({
      kind: "search",
      query: "eve protocol v26",
      sources: [
        { title: "Eve docs", url: "https://www.eve.dev/docs" },
        { title: "Changelog", url: "https://github.com/eve/eve/releases" },
      ],
      failure: null,
    });
  });

  it("a page read is a read step whose source is the page", () => {
    const running = toolFrame(
      frameOf(
        RUN,
        {
          type: "actions.requested",
          data: {
            turnId: "t2",
            actions: [
              { kind: "tool-call", callId: "c2", toolName: "web_fetch", input: { url: "https://example.com/a" } },
            ],
          },
        },
        5,
      ),
    );
    expect(running.facts).toEqual({ kind: "read", query: "https://example.com/a", sources: [], failure: null });
    const settled = toolFrame(
      frameOf(
        RUN,
        {
          type: "action.result",
          data: {
            turnId: "t2",
            status: "completed",
            result: {
              callId: "c2",
              toolName: "web_fetch",
              output: { ok: true, url: "https://example.com/a", title: "Page A", markdown: "# A" },
            },
          },
        },
        6,
      ),
    );
    expect(settled.facts?.sources).toEqual([{ title: "Page A", url: "https://example.com/a" }]);
  });

  it("a library search lists each document once, however many passages matched", () => {
    const passage = (documentId: string, title: string, start: number) => ({
      documentId,
      title,
      text: "passage",
      span: { start, end: start + 10, page: null },
    });
    const frame = toolFrame(
      frameOf(
        RUN,
        {
          type: "action.result",
          data: {
            status: "completed",
            result: {
              callId: "c3",
              toolName: "documents_search",
              output: { results: [passage("d1", "Notes", 0), passage("d1", "Notes", 50), passage("d2", "Paper", 0)] },
            },
          },
        },
        7,
      ),
    );
    expect(frame.facts?.sources).toEqual([
      { title: "Notes", documentId: "d1" },
      { title: "Paper", documentId: "d2" },
    ]);
    expect(frame.turnId).toBeUndefined();
  });

  it("reads sources off the full result even when the frame's payload is capped", () => {
    const results = Array.from({ length: 30 }, (_, index) => ({
      title: `Result ${index}`,
      url: `https://site${index}.example.org/page`,
      snippet: "x".repeat(400),
    }));
    expect(JSON.stringify({ results }).length).toBeGreaterThan(MAX_TOOL_PAYLOAD);
    const frame = toolFrame(
      frameOf(
        RUN,
        {
          type: "action.result",
          data: {
            status: "completed",
            result: { callId: "c4", toolName: "web_search", output: { ok: true, results } },
          },
        },
        8,
      ),
    );
    expect(frame.input).toMatchObject({ truncated: true });
    expect(frame.facts?.sources).toHaveLength(MAX_STEP_SOURCES);
    expect(frame.facts?.sources[0]).toEqual({ title: "Result 0", url: "https://site0.example.org/page" });
  });

  it("a failed call claims no sources", () => {
    const frame = toolFrame(
      frameOf(
        RUN,
        {
          type: "action.result",
          data: {
            status: "failed",
            error: { code: "provider_unavailable" },
            result: {
              callId: "c5",
              toolName: "web_search",
              output: { results: [{ title: "x", url: "https://x.org" }] },
            },
          },
        },
        9,
      ),
    );
    expect(frame).toMatchObject({ status: "error", detail: "provider_unavailable" });
    expect(frame.facts?.sources).toEqual([]);
  });
});

describe("stepFacts", () => {
  it("never invents a source: non-http urls and shapeless results are dropped", () => {
    expect(
      stepFacts("web_search", { query: "q" }, { results: [{ title: "x", url: "javascript:alert(1)" }, { foo: 1 }] }),
    ).toEqual({ kind: "search", query: "q", sources: [], failure: null });
    expect(stepFacts("tasks_read", {}, { tasks: [{ id: "t" }] })).toEqual({
      kind: "read",
      query: null,
      sources: [],
      failure: null,
    });
  });

  it("a result that says ok: false is a failure with its own reason, not a source list", () => {
    expect(stepFacts("web_fetch", { url: "https://a.org" }, { ok: false, error: "fetch failed" })).toEqual({
      kind: "read",
      query: "https://a.org",
      sources: [],
      failure: "fetch failed",
    });
  });
});

describe("mergeStepFacts", () => {
  it("keeps the running frame's query when the settled frame knows only the sources", () => {
    const running = stepFacts("web_search", { query: "first" }, undefined);
    const settled = stepFacts("web_search", undefined, { results: [{ title: "A", url: "https://a.org" }] });
    expect(mergeStepFacts(running, settled)).toEqual({
      kind: "search",
      query: "first",
      sources: [{ title: "A", url: "https://a.org" }],
      failure: null,
    });
  });

  it("a later frame with no sources does not erase sources already shown", () => {
    const shown = stepFacts("web_search", { query: "q" }, { results: [{ title: "A", url: "https://a.org" }] });
    const replay = stepFacts("web_search", { query: "q" }, undefined);
    expect(mergeStepFacts(shown, replay)?.sources).toHaveLength(1);
  });
});
