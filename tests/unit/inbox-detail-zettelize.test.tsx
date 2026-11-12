import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InboxDetail } from "@/app/(workspace)/command-center/inbox/inbox-detail";

/*
 * The detail pane's per-capture Zettelize verb, an icon in the action row.
 * The state-exactness rules it inherits from the verb row (D15): an open text
 * capture offers it, a capture with no readable words does not, a converted
 * capture shows its "Open ..." link instead, and an unconfigured model marks
 * the control unavailable with the reason as its description rather than
 * failing on the click. The jobs themselves are the domain's (zettel-jobs
 * integration suite); this suite pins what the pane promises on render.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/command-center/inbox",
}));
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
vi.mock("@/domains/capture/zettel-actions", () => ({ zettelizeAction: vi.fn() }));
vi.mock("@/domains/jobs/actions", () => ({
  dismissGenerationJobAction: vi.fn(),
  retryGenerationJobAction: vi.fn(),
  startWaitingGenerationJobAction: vi.fn(),
}));

type CaptureProps = Parameters<typeof InboxDetail>[0]["capture"];

const PROVIDER = { zettelProviderReady: true, zettelProviderReason: "", zettelJobs: [] };

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
  it("offers Zettelize as an icon verb beside the other verbs on an open text capture", () => {
    const html = renderDetail(textCapture());
    expect(html).toContain('aria-label="Zettelize into Ideas"');
    expect(html).toContain('aria-label="Save as note"');
    expect(html).toContain('aria-label="Make a task"');
    expect(html).toContain('aria-label="Turn into"');
    expect(html).toContain('aria-label="Archive (restore it any time)"');
    // The crowded text row is gone: no text buttons for these verbs.
    expect(html).not.toContain(">Save to library<");
    expect(html).not.toContain(">Make task<");
  });

  it("marks Zettelize unavailable with the provider reason when no model is configured", () => {
    const html = renderDetail(textCapture(), {
      zettelProviderReady: false,
      zettelProviderReason: "Zettelize needs a model. Set OPENROUTER_API_KEY or GEMINI_API_KEY.",
      zettelJobs: [],
    });
    expect(html).toMatch(/aria-label="Zettelize into Ideas"[^>]*aria-disabled="true"/);
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
