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

import { completeTask, createOwnerTask } from "@/domains/work/commands";
import { completeTaskAction, createTaskAction } from "@/app/(workspace)/neuralflow/work/actions";

/*
 * The action is the boundary the UI actually calls: a bad title must come back
 * as a message the composer renders, not a thrown stack that blanks the page,
 * and a task another tab already completed must say so rather than pretending.
 */

const created = vi.mocked(createOwnerTask);
const completed = vi.mocked(completeTask);

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
      error: "That task no longer exists.",
    });
    expect(completed).not.toHaveBeenCalled();
  });

  it("reports an already-decided task instead of claiming success", async () => {
    completed.mockResolvedValueOnce(null as never);
    const result = await completeTaskAction("11111111-1111-4111-8111-111111111111");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("already completed") });
  });

  it("succeeds when the row moves", async () => {
    completed.mockResolvedValueOnce({ id: "t1" } as never);
    expect(await completeTaskAction("11111111-1111-4111-8111-111111111111")).toEqual({ ok: true });
  });
});
