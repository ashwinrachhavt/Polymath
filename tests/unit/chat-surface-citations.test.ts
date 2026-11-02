import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatSurface } from "@/components/chat/chat-surface";
import type { ChatState } from "@/components/chat/use-chat-stream";

/*
 * Regression: ISSUE-007 — the sources chip counted citation passages, so five
 * passages of one document read as "Sources · 5". The chip names documents:
 * the count and the collapsed title list must be per-document, while the
 * expanded list keeps every passage.
 *
 * Value: protects=the owner reading "Sources · N" as N documents;
 * fails_when=a one-document, multi-passage answer counts its passages, or the
 * expanded list loses a passage; why_new=the chip's dedupe is inline in
 * ChatSurface with no other test; seam=ChatSurface rendered to static markup
 * with the stream hook mocked (the hook's network behaviour is
 * stream-contract.test.ts's seam); no_claim=markdown rendering, the composer,
 * the live SSE transport.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

// Captures the options the surface hands the hook: the seed is a pass-through,
// so asserting it landed here is what proves the wiring, not the mock's state.
const sentOptions: Array<{ initial?: { blocks?: Array<{ id: string }> } } | undefined> = [];
vi.mock("@/components/chat/use-chat-stream", () => ({
  useChatStream: (_runId: string, options?: { initial?: { blocks?: Array<{ id: string }> } }) => {
    sentOptions.push(options);
    return mockChatState();
  },
}));

let mockChatState: () => ChatState;

function stateWith(citations: ChatState["citations"]): () => ChatState {
  return () => ({
    blocks: [],
    tools: [],
    citations,
    connection: "streaming",
    error: null,
    retryable: true,
    lastFailedTurn: false,
    runFailed: false,
  });
}

/*
 * Regression: a resumed conversation rendered as empty. The surface streams
 * Eve, which replays only the turn in progress, so history stored in
 * run_events never reached it. The caller now passes it as `initial`, and the
 * surface must hand it to the stream hook as the seed.
 */
describe("ChatSurface seeded transcript", () => {
  it("forwards the stored transcript to the stream hook as its initial blocks", () => {
    mockChatState = stateWith([]);
    sentOptions.length = 0;
    const initial = [
      { id: "assistant:turn_0:0", kind: "assistant" as const, text: "Sierra retired its legacy rounds.", done: true },
    ];
    renderToStaticMarkup(
      createElement(ChatSurface, { runId: "run-1", subject: { type: "artifact", id: "run-1" }, initial }),
    );
    expect(sentOptions.at(-1)?.initial?.blocks).toEqual(initial);
  });

  it("passes no seed when the run has no stored history", () => {
    mockChatState = stateWith([]);
    sentOptions.length = 0;
    renderToStaticMarkup(createElement(ChatSurface, { runId: "run-1", subject: { type: "artifact", id: "run-1" } }));
    expect(sentOptions.at(-1)?.initial).toBeUndefined();
  });

  it("renders stored history instead of the empty prompt", () => {
    mockChatState = () => ({
      blocks: [{ id: "assistant:turn_0:0", kind: "assistant", text: "Sierra retired its legacy rounds.", done: true }],
      tools: [],
      citations: [],
      connection: "connecting",
      error: null,
      retryable: true,
      lastFailedTurn: false,
      runFailed: false,
    });
    const html = renderToStaticMarkup(
      createElement(ChatSurface, {
        runId: "run-1",
        subject: { type: "artifact", id: "run-1" },
        emptyText: "This conversation has no messages yet.",
      }),
    );
    expect(html).toContain("Sierra retired its legacy rounds.");
    expect(html).not.toContain("This conversation has no messages yet.");
  });
});

const passage = (documentId: string, title: string, start: number) => ({
  documentId,
  title,
  text: `Passage text ${start}`,
  span: { start, end: start + 10, page: null },
});

describe("ChatSurface sources chip", () => {
  it("counts documents, not passages, when one document backs several citations", () => {
    mockChatState = stateWith([
      passage("doc-a", "Cardinal handbook", 0),
      passage("doc-a", "Cardinal handbook", 120),
      passage("doc-a", "Cardinal handbook", 340),
    ]);
    const html = renderToStaticMarkup(
      createElement(ChatSurface, { runId: "run-1", subject: { type: "project", id: "d1" } }),
    );
    expect(html).toContain("Sources · 1");
    expect(html).not.toContain("Sources · 3");
    // Collapsed: the summary row names the document once — the expanded
    // passage rows are hidden content that static markup still emits, so the
    // collapsed-title assertion targets the summary's join line.
    expect(html).toContain('<span class="min-w-0 flex-1 truncate group-open:hidden">Cardinal handbook</span>');
  });

  it("lists distinct titles for several documents and keeps every passage when expanded", () => {
    mockChatState = stateWith([
      passage("doc-a", "Handbook", 0),
      passage("doc-a", "Handbook", 120),
      passage("doc-b", "Spec", 0),
    ]);
    const html = renderToStaticMarkup(
      createElement(ChatSurface, { runId: "run-1", subject: { type: "project", id: "d1" } }),
    );
    expect(html).toContain("Sources · 2");
    expect(html).toContain("Handbook, Spec");
    // The expanded list keeps each passage as its own row.
    expect(html).toContain("Passage text 0");
    expect(html).toContain("Passage text 120");
  });
});
