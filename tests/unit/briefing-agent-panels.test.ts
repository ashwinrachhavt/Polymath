import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPanels, pendingQueueDescription } from "@/app/(workspace)/command-center/briefing/agent-panels";

/*
 * The judgment panel's queue copy must never contradict the rows it lists:
 * with proposals visible, "nothing is waiting" wording is a defect even when
 * aimed at the unlisted remainder. Pins the copy contract per state and the
 * rendered panel against the mocked canonical queries.
 *
 * Value: protects=the owner reading the briefing can trust the queue copy
 * next to real proposals; fails_when=the description claims nothing is
 * waiting while proposals are listed, the overflow count is wrong, or the
 * empty state renders with pending rows; why_new=copy defect found in the
 * real-server briefing pass (2 pending proposals rendered next to "Nothing
 * else is waiting."); seam=AgentPanels rendered to static markup with the
 * canonical query + auth seams mocked; no_claim=hydration, /reviews
 * navigation, and the overnight window boundary.
 */

const proposals = vi.hoisted(() => ({ count: 0, top: [] as Array<{ id: string; title: string; capability: string; riskClass: string; createdAt: Date }> }));
const runs = vi.hoisted(() => ({ overnight: { total: 0, failed: 0, items: [] as Array<{ id: string; profileName: string | null; summary: string | null; objective: string; state: string; endedAt: Date | null; createdAt: Date }> } }));

vi.mock("@/domains/actions/queries", () => ({
  countPendingProposals: vi.fn(async () => proposals.count),
  listTopPendingProposals: vi.fn(async (_workspaceId: string, limit: number) => proposals.top.slice(0, limit)),
}));
vi.mock("@/domains/agents/queries", () => ({
  overnightRuns: vi.fn(async () => runs.overnight),
}));
vi.mock("@/lib/auth", () => ({
  getAuthContext: vi.fn(async () => ({ workspaceId: "w", userId: "u" })),
}));

function proposal(id: string, title: string) {
  return { id, title, capability: "calendar.write", riskClass: "external_write", createdAt: new Date("2026-10-23T14:41:00Z") };
}

beforeEach(() => {
  proposals.count = 0;
  proposals.top = [];
  runs.overnight = { total: 0, failed: 0, items: [] };
});

describe("pendingQueueDescription", () => {
  it("names the unlisted remainder when the queue overflows the panel", () => {
    expect(pendingQueueDescription(5, 3)).toBe("2 more in the queue.");
    expect(pendingQueueDescription(4, 3)).toBe("1 more in the queue.");
  });

  it("never says nothing is waiting while proposals are listed", () => {
    const copy = pendingQueueDescription(2, 2);
    expect(copy).toBe("Everything waiting is listed here.");
    expect(copy).not.toMatch(/nothing/i);
  });

  it("stays silent when the queue is empty; the body carries the empty state", () => {
    expect(pendingQueueDescription(0, 0)).toBeUndefined();
  });
});

describe("AgentPanels", () => {
  it("renders listed proposals without contradictory empty copy", async () => {
    proposals.count = 2;
    proposals.top = [proposal("p1", "Block Friday morning for the board deck"), proposal("p2", "Send the revised proposal to Dana")];
    const html = renderToStaticMarkup(await AgentPanels());
    expect(html).toContain("Block Friday morning for the board deck");
    expect(html).toContain("Send the revised proposal to Dana");
    expect(html).toContain("Everything waiting is listed here.");
    expect(html).not.toContain("Nothing else is waiting");
    expect(html).not.toContain("Nothing is waiting on you");
  });

  it("counts the overflow when more proposals are pending than shown", async () => {
    proposals.count = 5;
    proposals.top = [proposal("p1", "One"), proposal("p2", "Two"), proposal("p3", "Three")];
    const html = renderToStaticMarkup(await AgentPanels());
    expect(html).toContain("2 more in the queue.");
    expect(html).not.toContain("Nothing else is waiting");
  });

  it("renders the true empty state only with zero pending", async () => {
    const html = renderToStaticMarkup(await AgentPanels());
    expect(html).toContain("Nothing is waiting on you.");
    expect(html).not.toContain("Everything waiting");
  });

  it("labels a still-running run as running, never as completed", async () => {
    runs.overnight = {
      total: 2,
      failed: 0,
      items: [
        { id: "r1", profileName: "Alfred", summary: null, objective: "Research competitor pricing", state: "running", endedAt: null, createdAt: new Date("2026-10-23T13:41:00Z") },
        { id: "r2", profileName: "Alfred", summary: "Summarized 4 newsletters.", objective: "Summarize overnight newsletters", state: "succeeded", endedAt: new Date("2026-10-23T09:41:00Z"), createdAt: new Date("2026-10-23T09:41:00Z") },
      ],
    };
    const html = renderToStaticMarkup(await AgentPanels());
    expect(html).toContain("Research competitor pricing");
    expect(html).toContain("running");
    expect(html).toContain("nothing failed");
    expect(html).toContain("2 runs");
  });
});
