import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Make flashcards or a quiz dialog, opened from Learn or with inbox
 * captures in hand.
 *
 * Value: protects=the dialog handing work over instead of holding the
 * learner, a retry after a failure actually retrying, and the learner hearing
 * about sources left out of the request; fails_when=the dialog stays open or
 * navigates once the work is accepted, the accepted job is not put on the
 * page, a retry replays the failed request's key, or extra picks are dropped
 * without a word; seam=the client component under jsdom with the server
 * actions and the workspace notice mocked; no_claim=what the server does
 * with a key (tests/integration/make-learning-action.test.ts) or how a
 * finished job is announced (generation-jobs-client.test.tsx).
 */

const mocks = vi.hoisted(() => ({
  make: vi.fn(),
  find: vi.fn(),
  notify: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/app/(workspace)/learn/make-actions", () => ({
  makeFlashcardsOrQuizAction: mocks.make,
  findLearningSourcesAction: mocks.find,
}));
vi.mock("@/components/jobs/generation-jobs", () => ({ trackGenerationJob: mocks.track }));
vi.mock("@/components/workspace/workspace-provider", () => ({ useWorkspace: () => ({ notify: mocks.notify }) }));

const { MakeLearningButton } = await import("@/app/(workspace)/learn/make-learning-dialog");

const accepted = {
  id: "job-1",
  kind: "learning.flashcards",
  subject: null,
  status: "queued" as const,
  title: "Flashcards: Capture 1",
  attempt: 1,
  href: null,
  notice: null,
  error: null,
  createdAt: "2026-11-11T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:00.000Z",
};

function capture(n: number) {
  return {
    type: "capture" as const,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    version: 1,
    title: `Capture ${n}`,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.find.mockResolvedValue({ ok: true, documents: [], captures: [] });
});

function open(sources: ReturnType<typeof capture>[]) {
  render(<MakeLearningButton initialSources={sources}>Make</MakeLearningButton>);
  fireEvent.click(screen.getByRole("button", { name: "Make" }));
  return screen.getByRole("dialog");
}

describe("MakeLearningButton", () => {
  it("sends a fresh key when the learner tries again after a failure", async () => {
    mocks.make
      .mockResolvedValueOnce({ ok: false, error: "The quiz generator did not answer. Try again in a moment." })
      .mockResolvedValueOnce({ ok: true, job: accepted });
    const dialog = open([capture(1)]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Make flashcards" }));
    await within(dialog).findByText("The quiz generator did not answer. Try again in a moment.");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Make flashcards" }));
    await waitFor(() => expect(mocks.track).toHaveBeenCalledWith(accepted));

    const [first, second] = mocks.make.mock.calls.map(([input]) => input.idempotencyKey);
    expect(second).not.toBe(first);
  });

  it("says how many picked sources were left out of a request", () => {
    const dialog = open(Array.from({ length: 12 }, (_, i) => capture(i + 1)));

    expect(within(dialog).getByText("8 of 8 sources picked.")).toBeTruthy();
    expect(within(dialog).getByText(/4 more selected were left out/)).toBeTruthy();
  });

  it("closes as soon as the work is accepted and puts the job on the page, without waiting or navigating", async () => {
    mocks.make.mockResolvedValueOnce({ ok: true, job: accepted });
    const dialog = open([capture(1)]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Make flashcards" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.track).toHaveBeenCalledWith(accepted);
    expect(mocks.notify).toHaveBeenCalledWith(
      "Flashcards: Capture 1 is being made. It will show on Learn when it is ready.",
    );
  });
});
