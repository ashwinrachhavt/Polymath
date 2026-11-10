import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CaptureContextPanel } from "@/app/(workspace)/command-center/inbox/capture-context-panel";

/*
 * Value: protects=the inbox shows a capture's why, passage and source, and renders nothing for rows
 * written before context existed; fails_when=the null guard is dropped or a field stops rendering;
 * why_new=no test rendered the panel; seam=none; no_claim=visual layout
 */

const render = (rawPayload: unknown) => renderToStaticMarkup(h(CaptureContextPanel, { rawPayload }));

describe("CaptureContextPanel", () => {
  it("renders nothing for a capture with no context", () => {
    expect(render({ text: "an old row" })).toBe("");
  });

  it("says 'Not known yet' for an unknown why, and shows the passage inside its surroundings", () => {
    const html = render({
      text: "w",
      context: {
        why: { kind: "unknown" },
        passage: "the exact words",
        surrounding: { before: "Before them,", after: "and after" },
        source: { title: "An article", url: "https://example.com/a" },
      },
    });
    expect(html).toContain("Not known yet.");
    expect(html).toContain("<mark");
    expect(html).toContain("the exact words");
    expect(html).toContain("Before them,");
    expect(html).toContain('href="https://example.com/a"');
  });

  it("labels a dictated answer and a partial capture", () => {
    const html = render({
      context: { why: { kind: "answer", text: "it settles a question", via: "voice" }, partial: { reason: "cut" } },
    });
    expect(html).toContain("it settles a question");
    expect(html).toContain("dictated");
    expect(html).toContain("Partial capture.");
  });
});
