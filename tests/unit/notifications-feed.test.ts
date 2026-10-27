// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

/*
 * The notifications feed is the one surface that shows a decision, a run in
 * flight and an audit row together, so what it counts decides whether the
 * header badge is truthful. The rule under test: the badge counts what still
 * needs the owner (live decisions and in-flight runs) and never counts the
 * audit trail, because a record of something that already happened is not a
 * thing waiting on you.
 */

const listHomeQueue = vi.fn();
const listRecentRuns = vi.fn();
const listWorkspaceActivity = vi.fn();

vi.mock("@/domains/home/queue", () => ({ listHomeQueue: (...args: unknown[]) => listHomeQueue(...args) }));
vi.mock("@/domains/agents/queries", () => ({ listRecentRuns: (...args: unknown[]) => listRecentRuns(...args) }));
vi.mock("@/domains/audit/queries", () => ({
  listWorkspaceActivity: (...args: unknown[]) => listWorkspaceActivity(...args),
  // Mirrors the real projection: allowlisted actions render their own summary.
  projectSummary: (_action: string, summary: string) => summary,
}));

import { listNotifications } from "@/domains/notifications/feed";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

function seed() {
  listHomeQueue.mockResolvedValue([
    {
      origin: "agent",
      id: "proposal-1",
      title: "Send the deck to Priya",
      effect: "Sends one email.",
      reason: "Proposed by mail.send",
      riskClass: "external_write",
      expiresAt: null,
      createdAt: at(10),
      href: "/reviews?proposal=proposal-1",
      decision: { kind: "agent", revisionId: "revision-1", version: 3, expired: false },
    },
    {
      origin: "capture",
      id: "proposal-2",
      title: "Quarterly plan",
      effect: "Becomes a task.",
      reason: "The classifier read this capture",
      riskClass: "prepare",
      expiresAt: null,
      createdAt: at(5),
      href: "/command-center/inbox?id=capture-1",
      decision: { kind: "capture" },
    },
    {
      origin: "agent",
      id: "proposal-3",
      title: "Expired proposal",
      effect: "Sends one email.",
      reason: "Proposed by mail.send",
      riskClass: "external_write",
      expiresAt: at(60),
      createdAt: at(30),
      href: "/reviews?proposal=proposal-3",
      decision: { kind: "agent", revisionId: "revision-3", version: 1, expired: true },
    },
  ]);
  listRecentRuns.mockResolvedValue([
    { id: "run-1", state: "running", objective: "Summarize the week", model: "m", summary: null, error: null, createdAt: at(2) },
    { id: "run-2", state: "succeeded", objective: "Filed the receipts", model: "m", summary: "Done.", error: null, createdAt: at(90) },
  ]);
  listWorkspaceActivity.mockResolvedValue([
    { action: "task.created", actorKind: "user", subjectType: "task", summary: 'Created task "Send Dad\'s files"', createdAt: at(8) },
  ]);
}

describe("listNotifications", () => {
  it("counts only what still needs the owner, never the audit trail", async () => {
    seed();
    const feed = await listNotifications({ workspaceId: "ws-1" });
    // Two live decisions (the expired one does not need a call) + one running
    // run. The audit row and the finished run are history.
    expect(feed.needsAction).toBe(3);
    expect(feed.counts).toEqual({ decision: 3, run: 2, audit: 1 });
  });

  it("leads with what needs the owner, then newest first", async () => {
    seed();
    const feed = await listNotifications({ workspaceId: "ws-1" });
    // The running run is the newest needing-action item; the audit row is
    // older history and must not outrank it.
    expect(feed.items[0].title).toBe("Summarize the week");
    const firstHistory = feed.items.findIndex((item) => !item.needsAction);
    expect(feed.items.slice(firstHistory).every((item) => !item.needsAction)).toBe(true);
    // Within each group, newest first.
    for (const group of [feed.items.slice(0, firstHistory), feed.items.slice(firstHistory)]) {
      const times = group.map((item) => item.at.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    }
  });

  it("marks a running run as needing action and a finished one as not", async () => {
    seed();
    const feed = await listNotifications({ workspaceId: "ws-1" });
    const running = feed.items.find((item) => item.id === "run-1");
    const finished = feed.items.find((item) => item.id === "run-2");
    expect(running?.needsAction).toBe(true);
    expect(running?.state).toBe("Running");
    expect(finished?.needsAction).toBe(false);
    expect(finished?.state).toBe("Finished");
  });

  it("keeps the binding a one-tap approve needs on agent decisions", async () => {
    seed();
    const feed = await listNotifications({ workspaceId: "ws-1" });
    const agent = feed.items.find((item) => item.id === "proposal-1");
    expect(agent?.decision).toEqual({
      kind: "agent",
      proposalId: "proposal-1",
      revisionId: "revision-1",
      version: 3,
      expired: false,
    });
  });
});
