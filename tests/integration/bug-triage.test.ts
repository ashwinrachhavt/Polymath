import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bugSignals } from "@/domains/bug-triage/schema";
import type { GitHubIssues } from "@/domains/bug-triage/github";
import { makeTestDb } from "../helpers/test-workspace";

/*
 * The bug agent's two persistence invariants against real Postgres: one
 * fingerprint is one row (and one issue), and no more than the daily cap of
 * issues is filed in a UTC day, however many signals are waiting.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: NonNullable<typeof handle>["db"] | undefined } = { db: handle?.db };

vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db as never;
  },
}));

const { recordBugSignal, claimSignalsToFile } = await import("@/domains/bug-triage/store");
const { runBugTriagePass } = await import("@/domains/bug-triage/pass");
const { signalFromReport } = await import("@/domains/bug-triage/signal");

const config = { token: "unused", repo: "owner/repo", maxIssuesPerDay: 2 };
const DAY_ONE = new Date("2026-11-12T10:00:00Z");
const DAY_TWO = new Date("2026-11-13T00:30:00Z");

function report(n: number) {
  return signalFromReport({ route: `/screen-${"abcdefghij"[n]}`, errorId: `err${n}`, kind: "broken" });
}

function fakeGitHub(): GitHubIssues & { created: Array<{ title: string; labels: string[] }> } {
  let next = 100;
  const created: Array<{ title: string; labels: string[] }> = [];
  return {
    created,
    findByFingerprint: async () => null,
    findSimilar: async () => [],
    create: async (issue) => {
      created.push({ title: issue.title, labels: issue.labels });
      return next++;
    },
  };
}

suite("bug triage store", () => {
  beforeEach(async () => {
    await handle!.db.delete(bugSignals);
  });

  it("dedupes: the same fingerprint is one row with a count", async () => {
    expect(await recordBugSignal(report(0), DAY_ONE)).toEqual({ created: true });
    expect(await recordBugSignal(report(0), DAY_ONE)).toEqual({ created: false });
    await Promise.all([recordBugSignal(report(0), DAY_ONE), recordBugSignal(report(0), DAY_ONE)]);
    const rows = await handle!.db.select().from(bugSignals);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrences).toBe(4);
  });

  it("caps issues per UTC day and files the rest the next day", async () => {
    for (const n of [0, 1, 2, 3]) await recordBugSignal(report(n), DAY_ONE);
    // The most-seen signal goes first.
    await recordBugSignal(report(3), DAY_ONE);

    const github = fakeGitHub();
    expect(await runBugTriagePass({ config, github, appPages: [], now: DAY_ONE })).toEqual({ filed: 2, failed: 0 });
    expect(await runBugTriagePass({ config, github, appPages: [], now: DAY_ONE })).toEqual({ filed: 0, failed: 0 });
    expect(github.created[0].title).toBe("Something broke on /screen-d");

    expect(await runBugTriagePass({ config, github, appPages: [], now: DAY_TWO })).toEqual({ filed: 2, failed: 0 });
    expect(github.created).toHaveLength(4);
    const unfiled = await handle!.db.select().from(bugSignals).where(eq(bugSignals.filedAt, DAY_ONE));
    expect(unfiled).toHaveLength(2);
  });

  it("counts in-flight claims against the cap", async () => {
    for (const n of [0, 1, 2]) await recordBugSignal(report(n), DAY_ONE);
    const [first, second] = await Promise.all([claimSignalsToFile(2, DAY_ONE), claimSignalsToFile(2, DAY_ONE)]);
    expect(first.length + second.length).toBe(2);
  });

  it("never files a known fingerprint twice", async () => {
    await recordBugSignal(report(0), DAY_ONE);
    const github = fakeGitHub();
    await runBugTriagePass({ config, github, appPages: [], now: DAY_ONE });
    await recordBugSignal(report(0), DAY_TWO);
    await runBugTriagePass({ config, github, appPages: [], now: DAY_TWO });
    expect(github.created).toHaveLength(1);
  });

  it("adopts an issue GitHub already has after a crash, without filing again", async () => {
    await recordBugSignal(report(0), DAY_ONE);
    const github = { ...fakeGitHub(), findByFingerprint: async () => 77 };
    expect(await runBugTriagePass({ config, github, appPages: [], now: DAY_ONE })).toEqual({ filed: 0, failed: 0 });
    const [row] = await handle!.db.select().from(bugSignals);
    expect(row.issueNumber).toBe(77);
  });

  it("releases a failed filing for a later retry without spending the cap", async () => {
    await recordBugSignal(report(0), DAY_ONE);
    const github = {
      ...fakeGitHub(),
      create: async () => {
        throw new Error("GitHub POST /repos/owner/repo/issues failed with 502 for ada@example.com");
      },
    };
    expect(await runBugTriagePass({ config, github, appPages: [], now: DAY_ONE })).toEqual({ filed: 0, failed: 1 });
    const [row] = await handle!.db.select().from(bugSignals);
    expect(row.issueNumber).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    expect(row.lastError).not.toContain("ada@example.com");
    // Retry waits fifteen minutes.
    expect(await claimSignalsToFile(2, DAY_ONE)).toHaveLength(0);
    expect(await claimSignalsToFile(2, new Date(DAY_ONE.getTime() + 16 * 60_000))).toHaveLength(1);
  });
});
