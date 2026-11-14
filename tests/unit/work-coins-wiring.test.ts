// @vitest-environment jsdom
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Work list -> coins moment wiring: the "+N coins" toast mounts only when
 * a completion server action reports coins, for single and bulk completion.
 * value: protects=the trigger seam; fails_when=a completion that paid nothing
 * shows a toast, or a paying one shows none; seam=the server actions mocked at
 * the module boundary; no_claim=the award decision itself - the stones domain
 * (awardCoins) owns that, covered by integration tests.
 */

const completeTaskAction = vi.fn();
const completeTasksAction = vi.fn();
const createTaskAction = vi.fn();
const commitTaskAction = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(workspace)/neuralflow/work/actions", () => ({
  commitTaskAction: (...args: unknown[]) => commitTaskAction(...args),
  completeTaskAction: (...args: unknown[]) => completeTaskAction(...args),
  completeTasksAction: (...args: unknown[]) => completeTasksAction(...args),
  createTaskAction: (...args: unknown[]) => createTaskAction(...args),
}));

import { WorkList, type WorkListItem } from "@/app/(workspace)/neuralflow/work/work-list";

const rows: WorkListItem[] = [
  { row: { id: "11111111-1111-4111-8111-111111111111", title: "Write the release note", status: "in_progress", priority: "high", dueAt: null, version: 3, subtaskCount: 0, subtasksDone: 0, blockedBy: 0 }, href: "#", selected: false },
  { row: { id: "22222222-2222-4222-8222-222222222222", title: "Sweep the lint suppressions", status: "ready", priority: "low", dueAt: null, version: 1, subtaskCount: 0, subtasksDone: 0, blockedBy: 0 }, href: "#", selected: false },
];

const renderList = () => render(h(WorkList, { items: rows, addToToday: false, emptyState: h("p", null, "No tasks.") }));

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("Work list coins wiring", () => {
  it("a completion that paid coins shows the amount, with the sentence passed through", async () => {
    completeTaskAction.mockResolvedValue({ ok: true, coinsEarned: 5 });
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Done: complete Write the release note" }));
    fireEvent.change(screen.getByLabelText("What did you actually do?"), { target: { value: "Shipped the wiring." } });
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(screen.getByText("+5 coins")).toBeTruthy());
    expect(completeTaskAction).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "Shipped the wiring.");
  });

  it("a completion that paid nothing shows no toast", async () => {
    completeTaskAction.mockResolvedValue({ ok: true, coinsEarned: 0 });
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Done: complete Write the release note" }));
    fireEvent.click(screen.getByRole("button", { name: "Just complete" }));
    await waitFor(() => expect(completeTaskAction).toHaveBeenCalled());
    expect(screen.queryByText(/coins/)).toBeNull();
  });

  it("a bulk completion shows one toast with the batch's total", async () => {
    completeTasksAction.mockResolvedValue({ ok: true, completed: [rows[0].row.id, rows[1].row.id], skipped: [], unknown: [], unattempted: [], coinsEarned: 10 });
    renderList();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Write the release note" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Sweep the lint suppressions" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete 2 selected" }));
    await waitFor(() => expect(screen.getAllByText("+10 coins")).toHaveLength(1));
  });
});
