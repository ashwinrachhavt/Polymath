// @vitest-environment jsdom
import { act, createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_LEARNING_SOURCES } from "@/domains/learning/item-count";

/*
 * The bulk Zettelize verb (spec §4.2): the selection toolbar's control queues
 * exactly the selected ids, surfaces the action's skipped rows honestly (no
 * readable text, already filed, or not open - the list sees previews, not
 * bodies, so the action is the eligibility authority), and answers with a
 * status line + the Ideas link, never a spinner.
 *
 * Value: protects=the queued/skipped honesty contract on the bulk path;
 * fails_when=the summary guesses eligibility from previews or drops the skip
 * count; why_new=the domain integration suite pins the action's arithmetic,
 * not what the toolbar renders from it; seam=the server action mocked at the
 * module boundary; no_claim=the outbox worker's own behaviour.
 */

const generateZettelsAction = vi.fn();
vi.mock("@/app/(workspace)/command-center/inbox/actions", () => ({
  setCaptureStateAction: vi.fn(),
}));
vi.mock("@/app/(workspace)/command-center/inbox/zettel-actions", () => ({
  generateZettelsAction: (...args: unknown[]) => generateZettelsAction(...args),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/(workspace)/learn/make-actions", () => ({
  makeFlashcardsOrQuizAction: vi.fn(),
  findLearningSourcesAction: vi.fn(async () => ({ ok: true, documents: [], captures: [] })),
}));

import { InboxList, type InboxRow } from "@/app/(workspace)/command-center/inbox/inbox-list";

function row(id: string, title: string, overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    id,
    processingState: "unprocessed",
    parkedAt: null,
    kind: "text",
    createdAt: "2026-11-03T10:00:00.000Z",
    title,
    preview: "A line of the capture.",
    hasText: true,
    url: null,
    version: 1,
    convertedType: null,
    convertedId: null,
    ...overrides,
  };
}

const FIRST = row("11111111-1111-4111-8111-111111111111", "First capture");
const SECOND = row("22222222-2222-4222-8222-222222222222", "Second capture");
const FILED = row("33333333-3333-4333-8333-333333333333", "Already a note", {
  processingState: "converted",
  convertedType: "note",
  convertedId: "44444444-4444-4444-8444-444444444444",
});

const PROVIDER = { zettelProviderReady: true, zettelProviderReason: "" };

function renderList(rows: InboxRow[], provider = PROVIDER) {
  return render(
    createElement(InboxList, {
      rows,
      view: "all",
      selectedId: null,
      rawQuery: {},
      ...provider,
    }),
  );
}

afterEach(() => {
  cleanup();
  generateZettelsAction.mockReset();
});

describe("InboxList bulk zettelize", () => {
  it("queues exactly the selection and surfaces the action's skipped rows with the Ideas link", async () => {
    generateZettelsAction.mockResolvedValueOnce({
      ok: true,
      queued: 1,
      skipped: 1,
      captureIds: [FIRST.id],
    });
    const screen = renderList([FIRST, SECOND, FILED]);

    await act(async () => {
      screen.getByLabelText("Select capture: First capture").click();
    });
    await act(async () => {
      screen.getByLabelText("Select capture: Second capture").click();
    });
    expect(screen.getByRole("button", { name: "Zettelize" })).toBeTruthy();

    await act(async () => {
      screen.getByRole("button", { name: "Zettelize" }).click();
    });
    await waitFor(() => screen.getByRole("status"));

    expect(generateZettelsAction).toHaveBeenCalledWith(expect.objectContaining({ captureIds: [FIRST.id, SECOND.id] }));
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Creating zettels for 1 capture…");
    expect(status.textContent).toContain("Skipped 1 not eligible");
    expect(screen.getByRole("link", { name: "See in Ideas" }).getAttribute("href")).toBe("/polymath/ideas");
  });

  it("answers nothing queued when every selected row is skipped", async () => {
    generateZettelsAction.mockResolvedValueOnce({
      ok: true,
      queued: 0,
      skipped: 2,
      captureIds: [],
    });
    const screen = renderList([FIRST, SECOND]);
    await act(async () => {
      screen.getByLabelText("Select capture: First capture").click();
    });
    await act(async () => {
      screen.getByLabelText("Select capture: Second capture").click();
    });

    await act(async () => {
      screen.getByRole("button", { name: "Zettelize" }).click();
    });
    await waitFor(() => screen.getByRole("status"));

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Nothing queued.");
    expect(status.textContent).toContain("Skipped 2 not eligible");
  });

  it("renders the action's refusal in the toolbar's error list", async () => {
    generateZettelsAction.mockResolvedValueOnce({ ok: false, message: "Too many captures named at once." });
    const screen = renderList([FIRST, SECOND]);
    await act(async () => {
      screen.getByLabelText("Select capture: First capture").click();
    });

    await act(async () => {
      screen.getByRole("button", { name: "Zettelize" }).click();
    });
    await waitFor(() => screen.getByRole("alert"));

    expect(screen.getByRole("alert").textContent).toBe("Zettelize: Too many captures named at once.");
  });

  it("disables Zettelize with the provider reason when no model is configured", () => {
    const screen = renderList([FIRST], {
      zettelProviderReady: false,
      zettelProviderReason: "Zettelize needs a model. Set OPENROUTER_API_KEY or GEMINI_API_KEY.",
    });
    await_select(screen);

    const button = screen.getByRole("button", { name: "Zettelize" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Zettelize needs a model. Set OPENROUTER_API_KEY or GEMINI_API_KEY.");
  });
});

/** Selection needs an act; a helper keeps the provider-off case readable. */
async function await_select(screen: ReturnType<typeof renderList>) {
  await act(async () => {
    screen.getByLabelText("Select capture: First capture").click();
  });
}

describe("InboxList bulk flashcards or quiz", () => {
  it("leaves out a selected capture with no text yet, and says so", async () => {
    const voice = row("55555555-5555-4555-8555-555555555555", "Voice memo", {
      kind: "voice",
      preview: null,
      hasText: false,
    });
    const screen = renderList([FIRST, voice]);
    await act(async () => {
      screen.getByLabelText("Select capture: First capture").click();
    });
    await act(async () => {
      screen.getByLabelText("Select capture: Voice memo").click();
    });

    const button = screen.getByRole("button", { name: "Flashcards or quiz" });
    expect(button.getAttribute("title")).toContain("Leaves out 1 selected capture that cannot be a source");
    await act(async () => {
      button.click();
    });
    expect(screen.getByText(`1 of ${MAX_LEARNING_SOURCES} sources picked.`)).toBeTruthy();
  });
});
