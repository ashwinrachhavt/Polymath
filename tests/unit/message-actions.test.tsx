import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageActions } from "@/components/chat/message-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(workspace)/polymath/[runId]/message-actions", () => ({
  saveMessageAsNoteAction: vi.fn(),
  saveMessageAsIdeaAction: vi.fn(),
}));

describe("MessageActions", () => {
  it("renders copy and feedback for a finished answer", () => {
    const html = renderToStaticMarkup(createElement(MessageActions, { runId: "r1", turnId: "t1", text: "Answer" }));
    expect(html).toContain('aria-label="Copy"');
  });

  it("offers comment, save-as-note and save-as-idea on a finished answer", () => {
    const html = renderToStaticMarkup(
      createElement(MessageActions, { runId: "r1", turnId: "t1", text: "Answer", messageId: "m1" }),
    );
    expect(html).toContain('aria-label="Comment"');
    expect(html).toContain("Save as note");
    expect(html).toContain("Save as idea");
  });

  it("omits the comment control when the block has no stored message", () => {
    const html = renderToStaticMarkup(
      createElement(MessageActions, { runId: "r1", turnId: "t1", text: "Answer", messageId: null }),
    );
    expect(html).not.toContain('aria-label="Comment"');
    expect(html).toContain("Save as note");
  });
});
