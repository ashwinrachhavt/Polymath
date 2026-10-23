import { describe, expect, it, vi } from "vitest";

// The action module imports Clerk through getAuthContext and the domain
// commands through their module; both are stubbed so the test exercises the
// action's own contract — validation, the error mapping, and the revalidate.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthContext: vi.fn(async () => ({ userId: "u1", workspaceId: "w1", role: "owner" })),
}));
vi.mock("@/domains/work/commands", () => ({
  createOwnerTask: vi.fn(),
  completeTask: vi.fn(),
}));
vi.mock("@/domains/work/queries", () => ({
  getCompletionConflictState: vi.fn(),
}));

import { completeTask, createOwnerTask } from "@/domains/work/commands";
import { getCompletionConflictState } from "@/domains/work/queries";
import { completeTaskAction, createTaskAction } from "@/app/(workspace)/neuralflow/work/actions";

/*
 * The action is the boundary the UI actually calls: a bad title must come back
 * as a message the composer renders, not a thrown stack that blanks the page,
 * and a task another tab already completed must say so rather than pretending.
 */

const created = vi.mocked(createOwnerTask);
const completed = vi.mocked(completeTask);
const conflictState = vi.mocked(getCompletionConflictState);

describe("createTaskAction", () => {
  it("rejects a blank title without calling the domain", async () => {
    expect(await createTaskAction({ title: "   " })).toEqual({
      ok: false,
      error: "Give the task a title.",
    });
    expect(created).not.toHaveBeenCalled();
  });

  it("creates through the domain and returns the task id", async () => {
    created.mockResolvedValueOnce({ id: "t1" } as never);
    expect(await createTaskAction({ title: "Send the update", dueAt: "2026-11-01" })).toEqual({
      ok: true,
      taskId: "t1",
    });
    // The date string is coerced at the boundary, not passed through raw.
    expect(created.mock.calls[0][1].dueAt).toBeInstanceOf(Date);
  });
});

describe("completeTaskAction", () => {
  it("rejects a non-uuid without touching the domain", async () => {
    expect(await completeTaskAction("not-a-uuid")).toEqual({
      ok: false,
      kind: "conflict",
      error: "That task no longer exists.",
    });
    expect(completed).not.toHaveBeenCalled();
  });

  it("reports an already-decided task instead of claiming success", async () => {
    completed.mockResolvedValueOnce(null as never);
    conflictState.mockResolvedValueOnce({ status: "done", completionNote: null } as never);
    const result = await completeTaskAction("11111111-1111-4111-8111-111111111111");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ kind: "conflict", error: expect.stringContaining("already completed") });
  });

  it("a cancelled task is never mislabeled 'already completed'", async () => {
    completed.mockResolvedValueOnce(null as never);
    conflictState.mockResolvedValueOnce({ status: "cancelled", completionNote: null } as never);
    const result = await completeTaskAction("11111111-1111-4111-8111-111111111111");
    expect(result).toMatchObject({ ok: false, kind: "conflict", error: "That task was cancelled, not completed." });
  });

  it("an invisible task is unavailable, not completed", async () => {
    completed.mockResolvedValueOnce(null as never);
    conflictState.mockResolvedValueOnce(null as never);
    const result = await completeTaskAction("11111111-1111-4111-8111-111111111111");
    expect(result).toMatchObject({ ok: false, kind: "conflict", error: "That task is not available in this workspace." });
  });

  it("a lost response after commit reports the sentence as recorded, not lost", async () => {
    completed.mockResolvedValueOnce(null as never);
    conflictState.mockResolvedValueOnce({ status: "done", completionNote: "Finished the migration." } as never);
    const result = await completeTaskAction("11111111-1111-4111-8111-111111111111", "Finished the migration.");
    expect(result).toMatchObject({ ok: false, kind: "conflict", sentenceRecorded: true, error: expect.stringContaining("with this sentence recorded") });
  });

  it("a completed-elsewhere task with a different note reports the sentence as not recorded", async () => {
    completed.mockResolvedValueOnce(null as never);
    conflictState.mockResolvedValueOnce({ status: "done", completionNote: "Someone else's note." } as never);
    const result = await completeTaskAction("11111111-1111-4111-8111-111111111111", "My unsaved sentence.");
    expect(result).toMatchObject({ ok: false, kind: "conflict", sentenceRecorded: false });
  });

  it("a sentence over the cap is a validation error, never a completion", async () => {
    const result = await completeTaskAction("11111111-1111-4111-8111-111111111111", "x".repeat(281));
    expect(result).toMatchObject({ ok: false, kind: "validation" });
    expect(completed).not.toHaveBeenCalled();
  });

  it("succeeds when the row moves", async () => {
    completed.mockResolvedValueOnce({ id: "t1" } as never);
    expect(await completeTaskAction("11111111-1111-4111-8111-111111111111")).toEqual({ ok: true });
  });
});
