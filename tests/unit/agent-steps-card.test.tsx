import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatState } from "@/components/chat/use-chat-stream";

/*
 * The step card: open and naming the live step while a turn runs, folded to a
 * counted one-liner when it ends, and placed above the answer of the turn the
 * calls ran in rather than at the bottom of the transcript.
 */

vi.mock("@/components/feedback/rate-output-action", () => ({ rateOutputAction: vi.fn() }));
vi.mock("@/app/(workspace)/polymath/[runId]/message-actions", () => ({
  saveMessageAsNoteAction: vi.fn(),
  saveMessageAsIdeaAction: vi.fn(),
}));
vi.mock("@/app/(workspace)/polymath/[runId]/zettel-actions", () => ({ zettelizeThreadAction: vi.fn() }));

const { AgentSteps, stepsSummary } = await import("@/components/chat/agent-steps");
const { ChatTranscript } = await import("@/components/chat/chat-transcript");

const search = {
  id: "tool:c1",
  kind: "search" as const,
  label: "Searched the web",
  query: "eve protocol",
  sources: [
    { title: "Eve docs", url: "https://eve.dev/docs" },
    { title: "Release notes", url: "https://github.com/eve/releases" },
  ],
  status: "complete" as const,
  detail: "2 results",
};
const read = {
  id: "tool:c2",
  kind: "read" as const,
  label: "Read a web page",
  query: "https://eve.dev/docs",
  sources: [{ title: "Eve docs", url: "https://eve.dev/docs" }],
  status: "running" as const,
};

describe("AgentSteps", () => {
  it("while working, it is open and names the step in progress", () => {
    const html = renderToStaticMarkup(createElement(AgentSteps, { steps: [search, read], active: true }));
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Reading a web page: eve.dev");
    expect(html).toContain("step-shimmer");
    expect(html).toContain("Release notes");
  });

  it("when the turn is done, it folds to a counted summary with site icons", () => {
    const done = { ...read, status: "complete" as const };
    const html = renderToStaticMarkup(createElement(AgentSteps, { steps: [search, done], active: false }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Searched once · read 1 page · 2 sources");
    expect(html).toContain("icons.duckduckgo.com/ip3/eve.dev.ico");
    expect(html).toMatch(/referrer[pP]olicy="no-referrer"/);
    expect(html).not.toContain("Release notes");
  });

  it("counts failures and tools in the summary", () => {
    expect(
      stepsSummary([
        { ...search, status: "error" },
        { id: "tool:c3", kind: "tool", label: "Checked open tasks", query: null, sources: [], status: "complete" },
      ]),
    ).toBe("Used 1 tool · 2 sources · 1 step failed");
  });
});

describe("ChatTranscript step placement", () => {
  const blocks: ChatState["blocks"] = [
    { id: "user:stored:1", kind: "user", text: "First question", done: true },
    { id: "assistant:turn-1:0", kind: "assistant", text: "First answer", done: true },
    { id: "user:stored:3", kind: "user", text: "Second question", done: true },
    { id: "assistant:turn-2:0", kind: "assistant", text: "Second answer", done: true },
  ];
  const tool = (callId: string, turnId: string, query: string): ChatState["tools"][number] => ({
    callId,
    label: "web_search",
    status: "ok",
    detail: "1 result",
    turnId,
    facts: {
      kind: "search",
      query,
      sources: [{ title: `Result for ${query}`, url: `https://${callId}.example.org` }],
      failure: null,
    },
  });

  function render(tools: ChatState["tools"]) {
    return renderToStaticMarkup(
      createElement(ChatTranscript, {
        blocks,
        tools,
        ratings: [{ score: 5, comment: null, sequence: 4, turnId: "turn-2" }],
        citations: [],
        shownCitations: [],
        runId: "11111111-1111-4111-8111-111111111111",
        transcriptEmpty: false,
        optimistic: null,
        waiting: [],
        busy: false,
        subjectType: "artifact",
        error: null,
        runFailed: false,
        connection: "done",
        retryable: false,
        onRetry: () => {},
      }),
    );
  }

  it("puts each turn's card directly above that turn's answer", () => {
    const html = render([tool("c1", "turn-1", "alpha"), tool("c2", "turn-2", "beta")]);
    const at = (text: string) => html.indexOf(text);
    expect(at("First question")).toBeLessThan(at('data-agent-steps="done"'));
    const cards = [...html.matchAll(/data-agent-steps="done"/g)].map((match) => match.index ?? -1);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toBeLessThan(at("First answer"));
    expect(cards[1]).toBeGreaterThan(at("Second question"));
    expect(cards[1]).toBeLessThan(at("Second answer"));
  });

  it("shows each reply's own rating, and no thumbs", () => {
    const html = render([]);
    expect(html).toContain('aria-label="Rated 5 of 5, great. Change rating"');
    expect(html).toContain('aria-label="Rate this answer"');
    expect(html).not.toMatch(/Helpful|Not helpful/);
  });

  it("a turn that streamed several answer blocks offers the rating only on its last", () => {
    const stream: ChatState["blocks"] = [
      { id: "user:stored:1", kind: "user", text: "Question", done: true },
      { id: "assistant:turn-1:0", kind: "assistant", text: "I'll look that up.", done: true },
      { id: "assistant:turn-1:1", kind: "assistant", text: "Here is the answer.", done: true },
    ];
    const html = renderToStaticMarkup(
      createElement(ChatTranscript, {
        blocks: stream,
        tools: [],
        citations: [],
        shownCitations: [],
        runId: "11111111-1111-4111-8111-111111111111",
        transcriptEmpty: false,
        optimistic: null,
        waiting: [],
        busy: false,
        subjectType: "artifact",
        error: null,
        runFailed: false,
        connection: "done",
        retryable: false,
        onRetry: () => {},
      }),
    );
    expect(html.match(/aria-label="Copy"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Rate this answer"/g)).toHaveLength(1);
    expect(html.lastIndexOf('aria-label="Rate this answer"')).toBeGreaterThan(html.indexOf("Here is the answer."));
  });

  it("a search the tool itself reported as failed reads as failed, with its reason", () => {
    const failed: ChatState["tools"][number] = {
      ...tool("c5", "turn-1", "alpha"),
      facts: { kind: "search", query: "alpha", sources: [], failure: "web search failed (searxng: failed)" },
    };
    const html = render([failed]);
    expect(html).toContain("1 step failed");
    expect(html).not.toContain("Searched once");
  });

  it("a turn still searching with no answer yet shows its card at the end", () => {
    const html = render([tool("c9", "turn-3", "gamma")]);
    expect(html.indexOf('data-agent-steps="done"')).toBeGreaterThan(html.indexOf("Second answer"));
  });
});
