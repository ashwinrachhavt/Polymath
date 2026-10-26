// @vitest-environment jsdom
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Work list -> ceremony wiring (ASH-311): the ceremony mounts ONLY on a
 * real quartzEarned result from the completion server actions, for single
 * AND bulk completion, echoes the submitted sentence, and dismiss removes
 * it. This is the parent wiring harness; the ceremony's own behavior lives
 * in tests/unit/stone-ceremony.test.ts.
 * value: protects=the trigger seam (no ceremony without the canonical award
 * flag, one ceremony per award result, sentence threaded through);
 * fails_when=a completion without the award shows a ceremony, a bulk award
 * shows none, or the sentence is dropped; seam=the server actions mocked at
 * the module boundary (their domain behavior is owned by integration tests);
 * no_claim=the award decision itself - recordDailyQuartz owns that.
 */

const completeTaskAction = vi.fn();
const completeTasksAction = vi.fn();
const createTaskAction = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(workspace)/neuralflow/work/actions", () => ({
  completeTaskAction: (...args: unknown[]) => completeTaskAction(...args),
  completeTasksAction: (...args: unknown[]) => completeTasksAction(...args),
  createTaskAction: (...args: unknown[]) => createTaskAction(...args),
}));

import { WorkList, type WorkListItem } from "@/app/(workspace)/neuralflow/work/work-list";

const rows: WorkListItem[] = [
  { row: { id: "11111111-1111-4111-8111-111111111111", title: "Write the release note", status: "in_progress", priority: "high", dueAt: null, version: 3, subtaskCount: 0, subtasksDone: 0, blockedBy: 0 }, href: "#", selected: false },
  { row: { id: "22222222-2222-4222-8222-222222222222", title: "Sweep the lint suppressions", status: "ready", priority: "low", dueAt: null, version: 1, subtaskCount: 0, subtasksDone: 0, blockedBy: 0 }, href: "#", selected: false },
];

const renderList = () => render(h(WorkList, { items: rows, showQuickAdd: false, emptyState: h("p", null, "No tasks.") }));

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("Work list ceremony wiring", () => {
  it("single completion with quartzEarned mounts the ceremony and echoes the sentence", async () => {
    completeTaskAction.mockResolvedValue({ ok: true, quartzEarned: true });
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Done: complete Write the release note" }));
    fireEvent.change(screen.getByLabelText("What did you actually do?"), { target: { value: "Shipped the ceremony wiring." } });
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Quartz earned"));
    expect(completeTaskAction).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "Shipped the ceremony wiring.");
    expect(screen.getByRole("status").textContent).toContain("Shipped the ceremony wiring.");
  });

  it("single completion without the award mounts no ceremony", async () => {
    completeTaskAction.mockResolvedValue({ ok: true, quartzEarned: false });
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Done: complete Write the release note" }));
    fireEvent.click(screen.getByRole("button", { name: "Just complete" }));
    await waitFor(() => expect(completeTaskAction).toHaveBeenCalled());
    expect(screen.queryByText("Quartz earned")).toBeNull();
  });

  it("bulk completion with quartzEarned mounts exactly one ceremony", async () => {
    completeTasksAction.mockResolvedValue({ ok: true, completed: [rows[0].row.id, rows[1].row.id], skipped: [], unknown: [], unattempted: [], quartzEarned: true });
    renderList();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Write the release note" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Sweep the lint suppressions" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete 2 selected" }));
    await waitFor(() => expect(document.querySelectorAll(".stone-ceremony")).toHaveLength(1));
    expect(screen.getAllByText("Quartz earned")).toHaveLength(1);
  });

  it("dismissing the ceremony clears it and a later award can mount a fresh one", async () => {
    completeTaskAction.mockResolvedValue({ ok: true, quartzEarned: true });
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Done: complete Write the release note" }));
    fireEvent.click(screen.getByRole("button", { name: "Just complete" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Quartz earned"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Quartz earned")).toBeNull();
  });
});
