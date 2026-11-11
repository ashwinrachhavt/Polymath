import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InboxDetail } from "@/app/(workspace)/command-center/inbox/inbox-detail";

/*
 * Make flashcards or a quiz from the inbox detail files the capture first,
 * so the server re-renders the pane with the capture converted while the
 * dialog is still open. The dialog, and an error it shows, must survive that.
 *
 * Value: protects=the learner seeing why generation failed after filing;
 * fails_when=the converted re-render unmounts the open dialog;
 * seam=InboxDetail under jsdom, rerendered with the converted capture the
 * server sends; no_claim=filing or generation (integration suites).
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
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
vi.mock("@/app/(workspace)/command-center/inbox/zettel-actions", () => ({ generateZettelsAction: vi.fn() }));
vi.mock("@/app/(workspace)/learn/make-actions", () => ({
  makeFlashcardsOrQuizAction: vi.fn(),
  findLearningSourcesAction: vi.fn(async () => ({ ok: true, documents: [], captures: [] })),
}));

type CaptureProps = NonNullable<Parameters<typeof InboxDetail>[0]["capture"]>;

const OPEN: CaptureProps = {
  id: "11111111-1111-4111-8111-111111111111",
  processingState: "unprocessed",
  parkedAt: null,
  kind: "text",
  createdAt: "2026-11-03T10:00:00.000Z",
  title: "A captured essay",
  text: "Spaced repetition beats cramming.",
  url: null,
  version: 1,
  convertedType: null,
  convertedId: null,
};

function detail(capture: CaptureProps) {
  return <InboxDetail capture={capture} priorWriting={null} zettelProviderReady zettelProviderReason="" />;
}

describe("InboxDetail Make flashcards or a quiz", () => {
  it("keeps the dialog open when the capture re-renders as filed", () => {
    const { rerender } = render(detail(OPEN));
    fireEvent.click(screen.getByRole("button", { name: "Make flashcards or a quiz" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    rerender(
      detail({
        ...OPEN,
        processingState: "converted",
        convertedType: "document",
        convertedId: "22222222-2222-4222-8222-222222222222",
        version: 2,
      }),
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
