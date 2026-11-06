import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InboxDetail } from "@/app/(workspace)/command-center/inbox/inbox-detail";

/*
 * The detail pane's per-capture Zettelize verb. The state-exactness rules it
 * inherits from the verb row (D15): an open text capture offers it, a capture
 * with no readable words does not, a converted capture shows its "Open ..."
 * link instead, and an unconfigured model disables the control with the reason
 * in its title rather than failing on the click. The queue itself is the
 * domain's job (zettel-generation integration suite); this suite pins what the
 * pane promises on render.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(workspace)/command-center/inbox/actions", () => ({
  acceptProposalAction: vi.fn(),
  makeDraftAction: vi.fn(),
  makeDocumentAction: vi.fn(),
  makeNoteAction: vi.fn(),
  makeTaskAction: vi.fn(),
  rejectProposalAction: vi.fn(),
  retryCaptureUrlAction: vi.fn(),
  setCaptureStateAction: vi.fn(),
  unparkCaptureAction: vi.fn(),
  updateCaptureTextAction: vi.fn(),
}));
vi.mock("@/app/(workspace)/command-center/inbox/zettel-actions", () => ({
  generateZettelsAction: vi.fn(),
}));

type CaptureProps = Parameters<typeof InboxDetail>[0]["capture"];

const PROVIDER = { zettelProviderReady: true, zettelProviderReason: "" };

function textCapture(overrides: Partial<NonNullable<CaptureProps>> = {}): NonNullable<CaptureProps> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    processingState: "unprocessed",
    parkedAt: null,
    kind: "text",
    createdAt: "2026-11-03T10:00:00.000Z",
    title: "A captured essay",
    text: "Atomic notes compound. A zettel carries one idea.",
    url: null,
    version: 1,
    convertedType: null,
    convertedId: null,
    ...overrides,
  };
}

function renderDetail(capture: CaptureProps, provider = PROVIDER) {
  return renderToStaticMarkup(createElement(InboxDetail, { capture, priorWriting: null, ...provider }));
}

describe("InboxDetail zettelize verb", () => {
  it("offers Zettelize beside Save to library on an open text capture, disclosing the conversion", () => {
    const html = renderDetail(textCapture());
    expect(html).toContain("Zettelize");
    expect(html).toContain("Save to library");
    expect(html).toContain("Files this capture to your library, then proposes ideas for review.");
  });

  it("disables Zettelize with the provider reason when no model is configured", () => {
    const html = renderDetail(textCapture(), {
      zettelProviderReady: false,
      zettelProviderReason: "Zettelize needs a model. Set OPENROUTER_API_KEY or GEMINI_API_KEY.",
    });
    expect(html).toContain("Zettelize");
    expect(html).toContain("disabled");
    expect(html).toContain("Set OPENROUTER_API_KEY or GEMINI_API_KEY.");
  });

  it("hides Zettelize on a converted capture, which shows its home link instead", () => {
    const html = renderDetail(
      textCapture({
        processingState: "converted",
        convertedType: "note",
        convertedId: "22222222-2222-4222-8222-222222222222",
      }),
    );
    expect(html).not.toContain("Zettelize");
    expect(html).toContain("Open note");
  });

  it("hides Zettelize when the capture has no readable text", () => {
    const html = renderDetail(textCapture({ kind: "file", text: null, cleanText: null }));
    expect(html).not.toContain("Zettelize");
  });

  it("hides Zettelize on a voice capture whose transcript has not landed", () => {
    const html = renderDetail(textCapture({ kind: "voice", text: null, cleanText: null }));
    expect(html).not.toContain("Zettelize");
  });
});
