import { describe, expect, it } from "vitest";
import { sampleState } from "../fixtures/sample-workspace";
import { loopBeats, nextBeat } from "@/components/products/command-center/loop-story";
import type { WorkspaceState } from "@/components/workspace/types";

const today = "2026-10-17";

function state(patch: Partial<WorkspaceState>): WorkspaceState {
  return { ...sampleState, captures: [], reviews: [], rewards: [], focus: null, ...patch };
}

describe("loop story", () => {
  it("tells the six beats in order with each owning app", () => {
    expect(loopBeats(state({}), today).map((beat) => [beat.key, beat.app])).toEqual([
      ["capture", "command-center"], ["clarify", "command-center"], ["commit", "command-center"],
      ["focus", "neuralflow"], ["review", "command-center"], ["learn", "alfred"],
    ]);
  });

  it("points at clarifying first when captures are waiting", () => {
    const beats = loopBeats(state({ captures: [{ id: "c", text: "Call back", kind: "text", status: "UNPROCESSED", createdAt: `${today}T09:00:00Z` }] }), today);
    expect(nextBeat(beats)).toBe("clarify");
    expect(beats.find((beat) => beat.key === "capture")?.count).toBe(1);
  });

  it("moves to focus once three outcomes are accepted and returns to a running session", () => {
    const tasks = sampleState.tasks.map((task, index) => index < 3 ? { ...task, status: "READY" as const, tags: [...task.tags, `Outcome:${today}`] } : task);
    expect(nextBeat(loopBeats(state({ tasks }), today))).toBe("focus");
    const running = loopBeats(state({ tasks, focus: { taskId: tasks[0].id, startedAt: 0, remaining: 60, duration: 1500, status: "running", completed: 0 } }), today);
    expect(running.find((beat) => beat.key === "focus")).toMatchObject({ href: "/neuralflow/focus", action: "Return to focus" });
  });

  it("never invents work: an empty workspace has no next step", () => {
    expect(nextBeat(loopBeats(state({ tasks: [] }), today))).toBeUndefined();
  });
});
