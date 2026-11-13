import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageActions } from "@/components/chat/message-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/feedback/rate-output-action", () => ({ rateOutputAction: vi.fn() }));
vi.mock("@/app/(workspace)/polymath/[runId]/message-actions", () => ({
  saveMessageAsNoteAction: vi.fn(),
  saveMessageAsIdeaAction: vi.fn(),
}));

const reply = { runId: "r1", rated: { surface: "chat", runId: "r1", turnId: "t1" } as const, rating: null };

describe("MessageActions", () => {
  it("renders copy and the rating control for a finished answer", () => {
    const html = renderToStaticMarkup(createElement(MessageActions, { ...reply, text: "Answer" }));
    expect(html).toContain('aria-label="Copy"');
    expect(html).toContain('aria-label="Rate this answer"');
    expect(html).not.toContain('aria-label="Helpful"');
  });

  it("offers comment, save-as-note and save-as-idea on a finished answer", () => {
    const html = renderToStaticMarkup(createElement(MessageActions, { ...reply, text: "Answer", messageId: "m1" }));
    expect(html).toContain('aria-label="Comment"');
    expect(html).toContain("Save as note");
    expect(html).toContain("Save as idea");
  });

  it("omits the comment control when the block has no stored message", () => {
    const html = renderToStaticMarkup(createElement(MessageActions, { ...reply, text: "Answer", messageId: null }));
    expect(html).not.toContain('aria-label="Comment"');
    expect(html).toContain("Save as note");
  });
});
