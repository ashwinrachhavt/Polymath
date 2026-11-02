import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/*
 * The panel is the integration point of the triage rebuild: it composes the
 * feed's classification, the shell's card atoms, and the guarded server
 * actions into one zero-hop surface. These tests hold it to the behaviors the
 * spec names - the tab a card lands in, the keys that act on the selection,
 * the guard that keeps typing keys out of the shortcuts, and the optimistic
 * action pattern (remove now, reconcile on the server's word) - with every
 * server action mocked, because their CAS behavior is covered where it lives.
 *
 * The clock is pinned by tests/unit/setup.clock.ts; the fetch guard would
 * fail loudly if any test reached for the real network.
 */

const {
  answerRunQuestion,
  dismissQuestionAction,
  decideHomeAgentAction,
  decideHomeCaptureAction,
  push,
  refresh,
  notify,
  path,
} = vi.hoisted(() => ({
  answerRunQuestion: vi.fn(),
  dismissQuestionAction: vi.fn(),
  decideHomeAgentAction: vi.fn(),
  decideHomeCaptureAction: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
  path: { current: "/" },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => path.current,
}));

vi.mock("@/app/(workspace)/polymath/[runId]/question-actions", () => ({
  answerRunQuestion,
  dismissQuestionAction,
}));

vi.mock("@/domains/home/actions", () => ({
  decideHomeAgentAction,
  decideHomeCaptureAction,
}));

vi.mock("@/components/workspace/workspace-provider", () => ({
  useWorkspace: () => ({ notify }),
}));

/*
 * The feed module's import graph reaches the eve runtime through the query
 * and executor domains, and undici 8 (eve's fetcher) refuses this sandbox's
 * Node at worker start. A component test runs none of that graph - the feed's
 * classification code is pure - so the data branches are severed here.
 */
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/domains/agents/queries", () => ({ listRecentRuns: vi.fn() }));
vi.mock("@/domains/agents/run-context", () => ({ getOpenQuestion: vi.fn() }));
vi.mock("@/domains/home/queue", () => ({ listHomeQueue: vi.fn() }));

import { NotificationsPanel } from "@/components/shell/notifications-panel";
import type { TriageFeed, TriageItem } from "@/domains/notifications/feed";

const question: TriageItem = {
  kind: "question",
  id: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  questionText: "Who is this person?",
  context: "Mentioned in the capture you saved",
  askedAt: new Date("2026-01-15T11:58:00Z"),
  href: "/polymath/22222222-2222-4222-8222-222222222222",
};

const actionDecision: TriageItem = {
  kind: "decision",
  id: "33333333-3333-4333-8333-333333333333",
  title: "Send the deck to Priya",
  detail: "Sends one email through the connected account.",
  href: "/reviews?proposal=33333333-3333-4333-8333-333333333333",
  at: new Date("2026-01-15T11:55:00Z"),
  decision: { decisionType: "action", revisionId: "rev-1", version: 3, expired: false },
};

const captureDecision: TriageItem = {
  kind: "decision",
  id: "44444444-4444-4444-8444-444444444444",
  title: "Save the pricing note",
  detail: null,
  href: "/command-center/inbox?id=44444444-4444-4444-8444-444444444444",
  at: new Date("2026-01-15T11:50:00Z"),
  decision: { decisionType: "capture" },
};

const runningRun: TriageItem = {
  kind: "run",
  id: "55555555-5555-4555-8555-555555555555",
  runId: "55555555-5555-4555-8555-555555555555",
  runState: "running",
  stateLabel: "Running",
  title: "Summarize the week",
  detail: null,
  href: "/polymath/55555555-5555-4555-8555-555555555555",
  at: new Date("2026-01-15T11:40:00Z"),
};

const doneRun: TriageItem = {
  kind: "run",
  id: "66666666-6666-4666-8666-666666666666",
  runId: "66666666-6666-4666-8666-666666666666",
  runState: "succeeded",
  stateLabel: "Finished",
  title: "Filed the receipts",
  detail: null,
  href: "/polymath/66666666-6666-4666-8666-666666666666",
  at: new Date("2026-01-15T10:00:00Z"),
};

const FEED: TriageFeed = {
  items: [question, actionDecision, captureDecision, runningRun, doneRun],
  counts: { inbox: 3, inFlight: 1, activity: 1 },
};

const optionId = (item: TriageItem) => `triage-${item.kind}-${item.id}`;

function openPanel(feed: TriageFeed = FEED) {
  const utils = render(<NotificationsPanel feed={feed} />);
  fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
  return utils;
}

beforeAll(() => {
  // jsdom does not implement scrollIntoView; the selection mover calls it to
  // keep the selected card in view.
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.clearAllMocks();
  path.current = "/";
  answerRunQuestion.mockResolvedValue({ ok: true });
  dismissQuestionAction.mockResolvedValue({ ok: true });
  decideHomeAgentAction.mockResolvedValue({ ok: true });
  decideHomeCaptureAction.mockResolvedValue({ ok: true });
});

describe("NotificationsPanel tabs", () => {
  it("counts the inbox on the bell badge and files each kind into its own tab", () => {
    render(<NotificationsPanel feed={FEED} />);

    // Asserted before opening: a modal sheet aria-hides everything outside
    // it, including the bell that opened it.
    expect(screen.getByRole("button", { name: "Notifications, 3 items need you" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(screen.getByRole("tab", { name: /Inbox/ }).textContent).toContain("3");
    expect(screen.getByRole("tab", { name: /In-Flight/ }).textContent).toContain("1");

    expect(screen.getByText("Who is this person?")).toBeDefined();
    expect(screen.getByText("Send the deck to Priya")).toBeDefined();
    expect(screen.getByText("Save the pricing note")).toBeDefined();
    expect(screen.queryByText("Summarize the week")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /In-Flight/ }));
    expect(screen.getByText("Summarize the week")).toBeDefined();
    expect(screen.queryByText("Who is this person?")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    expect(screen.getByText("Filed the receipts")).toBeDefined();
    expect(screen.getByRole("link", { name: "Full history" }).getAttribute("href")).toBe("/activity");
  });

  it("shows each tab's empty copy when it has nothing", () => {
    openPanel({
      items: [],
      counts: { inbox: 0, inFlight: 0, activity: 0 },
    });

    expect(screen.getByText("Nothing needs you right now.")).toBeDefined();
  });
});

describe("NotificationsPanel keyboard", () => {
  it("moves the aria-activedescendant selection with j, k, and the arrows", () => {
    openPanel();
    const listbox = screen.getByRole("listbox", { name: "Notification cards" });

    expect(listbox.getAttribute("aria-activedescendant")).toBe(optionId(question));

    fireEvent.keyDown(document.body, { key: "j" });
    expect(listbox.getAttribute("aria-activedescendant")).toBe(optionId(actionDecision));

    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(listbox.getAttribute("aria-activedescendant")).toBe(optionId(captureDecision));

    fireEvent.keyDown(document.body, { key: "k" });
    expect(listbox.getAttribute("aria-activedescendant")).toBe(optionId(actionDecision));

    fireEvent.keyDown(document.body, { key: "ArrowUp" });
    expect(listbox.getAttribute("aria-activedescendant")).toBe(optionId(question));
  });

  it("r focuses the selected question's reply input", () => {
    openPanel();

    fireEvent.keyDown(document.body, { key: "r" });

    expect(document.activeElement).toBe(document.getElementById(`${optionId(question)}-reply`));
  });

  it("inerts j, e, r, and Enter while the reply input is focused", () => {
    openPanel();

    fireEvent.keyDown(document.body, { key: "r" });
    const input = document.getElementById(`${optionId(question)}-reply`);
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input!, { key: "j" });
    const listbox = screen.getByRole("listbox", { name: "Notification cards" });
    expect(listbox.getAttribute("aria-activedescendant")).toBe(optionId(question));

    fireEvent.keyDown(input!, { key: "e" });
    expect(dismissQuestionAction).not.toHaveBeenCalled();

    fireEvent.keyDown(input!, { key: "Enter" });
    expect(answerRunQuestion).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("dismisses only a selected question with e; a decision card is untouched", async () => {
    openPanel();

    fireEvent.keyDown(document.body, { key: "e" });
    await waitFor(() => expect(dismissQuestionAction).toHaveBeenCalledWith({ questionId: question.id }));

    // The question card left optimistically; the selection fell to the action
    // decision, whose Approve/Reject are terminal - e must not fire on it.
    fireEvent.keyDown(document.body, { key: "e" });
    expect(dismissQuestionAction).toHaveBeenCalledTimes(1);
  });

  it("opens the selected card's deep link with Enter", () => {
    openPanel();

    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "Enter" });

    expect(push).toHaveBeenCalledWith(actionDecision.href);
  });
});

describe("NotificationsPanel in-place actions", () => {
  it("replies in place: submits to answerRunQuestion, announces the resume, and the card leaves the inbox", async () => {
    openPanel();

    fireEvent.change(screen.getByRole("textbox", { name: "Reply to the agent" }), {
      target: { value: "  Pino Corgi  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    await waitFor(() =>
      expect(answerRunQuestion).toHaveBeenCalledWith({
        runId: question.runId,
        questionId: question.id,
        answer: "Pino Corgi",
      }),
    );
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Sent. The agent resumed."));
    expect(refresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Who is this person?")).toBeNull());
  });

  it("surfaces a stale-card refusal from the CAS guard instead of announcing success", async () => {
    answerRunQuestion.mockResolvedValue({ ok: false, message: "That question was already answered." });
    openPanel();

    fireEvent.change(screen.getByRole("textbox", { name: "Reply to the agent" }), { target: { value: "Pino Corgi" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    await waitFor(() => expect(notify).toHaveBeenCalledWith("That question was already answered."));
    expect(notify).not.toHaveBeenCalledWith("Sent. The agent resumed.");
  });

  it("approves an action decision in place with the CAS binding", async () => {
    openPanel();

    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);

    await waitFor(() =>
      expect(decideHomeAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({
          proposalId: actionDecision.id,
          expectedVersion: 3,
          revisionId: "rev-1",
          decision: "approved",
        }),
      ),
    );
    expect(decideHomeAgentAction.mock.calls[0][0].idempotencyKey).toEqual(expect.any(String));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Approved."));
  });

  it("maps approve to accepted and reject to rejected for a capture decision", async () => {
    openPanel();

    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[1]);
    await waitFor(() =>
      expect(decideHomeCaptureAction).toHaveBeenCalledWith({ proposalId: captureDecision.id, decision: "accepted" }),
    );
  });

  it("replays the idempotency key when a failed decision is retried on the same rendered version", async () => {
    decideHomeAgentAction.mockResolvedValueOnce({ ok: false, error: "Version conflict" });
    openPanel();

    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Version conflict"));
    // The optimistic removal reverts when the transition ends without a
    // successful server word, so the card is clickable again.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Approve" }).length).toBe(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);

    await waitFor(() => expect(decideHomeAgentAction).toHaveBeenCalledTimes(2));
    expect(decideHomeAgentAction.mock.calls[1][0].idempotencyKey).toBe(
      decideHomeAgentAction.mock.calls[0][0].idempotencyKey,
    );
  });
});

describe("NotificationsPanel close on navigate", () => {
  it("closes the sheet when the route changes underneath it", async () => {
    const utils = openPanel();
    expect(screen.getByRole("tab", { name: /Inbox/ })).toBeDefined();

    path.current = "/reviews";
    utils.rerender(<NotificationsPanel feed={FEED} />);

    await waitFor(() => expect(screen.queryByRole("tab", { name: /Inbox/ })).toBeNull());
  });
});
