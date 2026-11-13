// @vitest-environment jsdom
import { act, createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_LEARNING_SOURCES } from "@/domains/learning/item-count";
import type { GenerationJobView } from "@/domains/jobs/state";

/*
 * The bulk Zettelize verb: the selection toolbar's control asks for one job
 * per selected capture, shows each accepted job as a row above the list (the
 * jobs stream moves it to ready or failed from there), says honestly how many
 * selected captures were left out, and clears the selection once the jobs are
 * accepted.
 *
 * Value: protects=one-job-per-source on the bulk path and the left-out
 * honesty; fails_when=the toolbar sends something other than the selection,
 * drops the skip count, or waits on the work; seam=the server action mocked at
 * the module boundary; no_claim=the runner's own behaviour (integration suite).
 */

const zettelizeAction = vi.fn();
vi.mock("@/app/(workspace)/command-center/inbox/actions", () => ({
  setCaptureStateAction: vi.fn(),
}));
vi.mock("@/domains/capture/zettel-actions", () => ({
  zettelizeAction: (...args: unknown[]) => zettelizeAction(...args),
}));
vi.mock("@/domains/jobs/actions", () => ({
  dismissGenerationJobAction: vi.fn(),
  retryGenerationJobAction: vi.fn(),
  startWaitingGenerationJobAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/command-center/inbox",
}));
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

const PROVIDER = { zettelProviderReady: true, zettelProviderReason: "", zettelJobs: [] };

function job(id: string, title: string): GenerationJobView {
  return {
    id,
    kind: "zettels.source",
    subject: `capture:${id}`,
    status: "queued",
    title,
    attempt: 1,
    href: null,
    notice: null,
    error: null,
    progress: null,
    createdAt: "2026-11-12T10:00:00.000Z",
    updatedAt: "2026-11-12T10:00:00.000Z",
  };
}

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
  zettelizeAction.mockReset();
});

describe("InboxList bulk zettelize", () => {
  it("asks for one job per selected capture, shows the jobs, and says what was left out", async () => {
    zettelizeAction.mockResolvedValueOnce({
      ok: true,
      jobs: [job("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Ideas: First capture")],
      skipped: 1,
    });
    const screen = renderList([FIRST, SECOND, FILED]);

    await act(async () => {
      screen.getByLabelText("Select capture: First capture").click();
    });
    await act(async () => {
      screen.getByLabelText("Select capture: Second capture").click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Zettelize" }).click();
    });
    await waitFor(() => screen.getByText("Ideas: First capture"));

    expect(zettelizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          { kind: "capture", id: FIRST.id },
          { kind: "capture", id: SECOND.id },
        ],
      }),
    );
    expect(screen.getByText(/Left out 1 with no readable text/)).toBeTruthy();
    // The jobs are accepted, so the selection (and its toolbar) is done.
    expect(screen.queryByRole("toolbar", { name: "Bulk actions" })).toBeNull();
  });

  it("renders the action's refusal in the toolbar and keeps the selection", async () => {
    zettelizeAction.mockResolvedValueOnce({ ok: false, message: "Zettelize up to 20 at a time." });
    const screen = renderList([FIRST, SECOND]);
    await act(async () => {
      screen.getByLabelText("Select capture: First capture").click();
    });

    await act(async () => {
      screen.getByRole("button", { name: "Zettelize" }).click();
    });
    await waitFor(() => screen.getByRole("alert"));

    expect(screen.getByRole("alert").textContent).toBe("Zettelize: Zettelize up to 20 at a time.");
    expect(screen.getByRole("toolbar", { name: "Bulk actions" })).toBeTruthy();
  });

  it("disables Zettelize with the provider reason when no model is configured", async () => {
    const screen = renderList([FIRST], {
      zettelProviderReady: false,
      zettelProviderReason: "Zettelize needs a model. Set OPENROUTER_API_KEY or GEMINI_API_KEY.",
      zettelJobs: [],
    });
    await await_select(screen);

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
