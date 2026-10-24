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

const failedConnect = vi.fn().mockImplementation(() => {
  throw new Error("unit test must not open a stream");
});
vi.mock("@/components/chat/use-chat-stream", () => ({
  useChatStream: () => mockChatState(),
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
  });
}

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
      createElement(ChatSurface, { runId: "run-1", subject: { type: "dossier", id: "d1" } }),
    );
    expect(html).toContain("Sources · 1");
    expect(html).not.toContain("Sources · 3");
    // Collapsed: the summary row names the document once — the expanded
    // passage rows are hidden content that static markup still emits, so the
    // collapsed-title assertion targets the summary's join line.
    expect(html).toContain("<span class=\"min-w-0 flex-1 truncate group-open:hidden\">Cardinal handbook</span>");
  });

  it("lists distinct titles for several documents and keeps every passage when expanded", () => {
    mockChatState = stateWith([
      passage("doc-a", "Handbook", 0),
      passage("doc-a", "Handbook", 120),
      passage("doc-b", "Spec", 0),
    ]);
    const html = renderToStaticMarkup(
      createElement(ChatSurface, { runId: "run-1", subject: { type: "dossier", id: "d1" } }),
    );
    expect(html).toContain("Sources · 2");
    expect(html).toContain("Handbook, Spec");
    // The expanded list keeps each passage as its own row.
    expect(html).toContain("Passage text 0");
    expect(html).toContain("Passage text 120");
  });
});
