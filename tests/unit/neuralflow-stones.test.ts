import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countLabel } from "@/components/products/neuralflow/planning";
import { formingProgress, stoneCatalog, stoneCollection, stoneForReward, stoneReason } from "@/components/products/neuralflow/stones";

const reward = (title: string, sessionId: string) => ({ id: sessionId, title, earnedAt: "2026-10-17T12:00:00.000Z", sessionId });

describe("NeuralFlow stone collection", () => {
  it("ships every catalog image locally and maps only the clarity stone to an earning rule", () => {
    for (const stone of stoneCatalog) expect(existsSync(join(process.cwd(), "public", stone.image))).toBe(true);
    expect(stoneCatalog.filter((stone) => stone.rewardTitle).map((stone) => stone.slug)).toEqual(["quartz"]);
    expect(stoneForReward("Clarity stone")?.name).toBe("Quartz of Clarity");
  });

  it("derives earned counts from ledger entries only and never unlocks catalog stones", () => {
    const empty = stoneCollection([], "all");
    expect(empty).toHaveLength(stoneCatalog.length);
    expect(empty.every((entry) => entry.earned.length === 0)).toBe(true);
    expect(empty.filter((entry) => entry.earnable).map((entry) => entry.title)).toEqual(["Clarity stone"]);
    expect(stoneCollection([], "earned")).toEqual([]);

    const ledger = [reward("Clarity stone", "neuralflow-focus:a"), reward("Clarity stone", "neuralflow-focus:b"), reward("Focus stone", "legacy")];
    const earned = stoneCollection(ledger, "earned");
    expect(earned.map((entry) => [entry.title, entry.earned.length])).toEqual([["Clarity stone", 2], ["Focus stone", 1]]);
    expect(earned.find((entry) => entry.title === "Focus stone")?.stone).toBeUndefined();
  });

  it("explains every earned stone from its own session key without guessing", () => {
    const tasks = [{ id: "task-architecture", title: "Review the data model" }];
    expect(stoneReason(reward("Clarity stone", "neuralflow-focus:task-architecture:1760000000000:25:0"), tasks)).toBe('Completed a focus interval on "Review the data model".');
    expect(stoneReason(reward("Clarity stone", "neuralflow-focus:task-gone:1760000000000:25:0"), tasks)).toBe("Completed a focus interval on a task that is no longer in this preview.");
    expect(stoneReason(reward("Focus stone", "legacy"), tasks)).toMatch(/session detail is not available/);
  });

  it("clamps forming progress and handles an empty interval", () => {
    expect(formingProgress(30, 60)).toBe(0.5);
    expect(formingProgress(90, 60)).toBe(1);
    expect(formingProgress(-5, 60)).toBe(0);
    expect(formingProgress(10, 0)).toBe(0);
  });

  it("pluralises interface counts", () => {
    expect(countLabel(1, "task")).toBe("1 task");
    expect(countLabel(0, "task")).toBe("0 tasks");
    expect(countLabel(2, "matching task")).toBe("2 matching tasks");
  });
});
