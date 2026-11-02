import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageActions } from "@/components/chat/message-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe("MessageActions", () => {
  it("renders copy and feedback for a finished answer", () => {
    const html = renderToStaticMarkup(createElement(MessageActions, { runId: "r1", turnId: "t1", text: "Answer" }));
    expect(html).toContain('aria-label="Copy"');
  });
});
