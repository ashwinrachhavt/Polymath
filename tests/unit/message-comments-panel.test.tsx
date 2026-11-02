import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageComments } from "@/components/chat/message-comments";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(workspace)/polymath/[runId]/comment-actions", () => ({
  addMessageCommentAction: vi.fn(),
  resolveMessageCommentAction: vi.fn(),
}));

describe("MessageComments", () => {
  it("renders an existing comment with its author and body", () => {
    const html = renderToStaticMarkup(
      createElement(MessageComments, {
        messageId: "m1",
        initialComments: [
          {
            id: "c1",
            body: "Worth keeping.",
            resolvedAt: null,
            createdAt: new Date().toISOString(),
            authorName: "Ashwin",
          },
        ],
      }),
    );
    expect(html).toContain("Worth keeping.");
    expect(html).toContain("Ashwin");
  });

  it("strikes a resolved comment and offers Reopen", () => {
    const html = renderToStaticMarkup(
      createElement(MessageComments, {
        messageId: "m1",
        initialComments: [
          {
            id: "c1",
            body: "Done with this.",
            resolvedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            authorName: null,
          },
        ],
      }),
    );
    expect(html).toContain("Reopen");
    expect(html).toContain("line-through");
  });
});
