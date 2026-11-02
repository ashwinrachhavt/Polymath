import { and, eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { importedAgentSessions } from "@/domains/agents/schema";
import { auditEvents, blobObjects } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Idempotent re-scan, against the real database and object store (the
 * re-spec's verification table): the same transcript scanned twice must
 * produce one row per (workspace, source, session id), reuse one blob row,
 * and never erase a decision note a human recorded on the first pass.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
type HandleDb = NonNullable<typeof handle>["db"];
const holder: { db: HandleDb | undefined } = { db: undefined };

vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db as never;
  },
}));

const { ingestSessionRecords } = await import("@/domains/agents/session-scan");
const { collectSessionRecords } = await import("@/lib/agent-artifacts/scan");

const CODEX_MAIN = "rollout-2026-11-01T09-00-00-11111111-2222-3333-4444-555555555555.jsonl";

function fixtureText(relative: string): string {
  return readFileSync(fileURLToPath(new URL("../fixtures/agent-artifacts/" + relative, import.meta.url)), "utf8");
}

function writeFixtureTree(): { claudeRoot: string; codexRoot: string } {
  const home = mkdtempSync(join(tmpdir(), "aa-int-"));
  const slugDir = join(home, "projects", "-home-pino-Polymath");
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    join(slugDir, "aaaa1111-2222-3333-4444-555555555555.jsonl"),
    fixtureText("claude-code/session-with-replay.jsonl"),
  );
  const day = join(home, "codex-home", "sessions", "2026", "11", "01");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, CODEX_MAIN), fixtureText("codex/" + CODEX_MAIN));
  return { claudeRoot: home, codexRoot: join(home, "codex-home") };
}

suite("agent-artifact session ingest", () => {
  let auth: ReturnType<typeof ownerAuth>;
  let workspaceId: string;
  const roots = writeFixtureTree();

  beforeAll(async () => {
    if (!handle) return;
    // The local object-store root is read per putBlob call, so pointing it at
    // a throwaway directory keeps real blob bytes out of the repo checkout.
    process.env.AXIOM_LOCAL_BLOB_DIR = mkdtempSync(join(tmpdir(), "aa-blobs-"));
    holder.db = handle.db;
    // Slug is unique per run: seedWorkspace inserts the user without an
    // upsert, so a fixed slug fails the second local run against one DB.
    const seed = await seedWorkspace(handle.db, "aa-scan-" + Date.now());
    auth = ownerAuth(seed.userId, seed.workspaceId);
    workspaceId = seed.workspaceId;
  });

  it("imports both sources with a recorded decision note and deduped blobs", async () => {
    const scan = await collectSessionRecords({ roots });
    expect(scan.records).toHaveLength(2);

    const result = await ingestSessionRecords(auth, scan.records, {
      decisionNote: "Fixing the login flake",
    });
    expect(result.imported).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.blobsDeduped).toBe(0);

    const rows = await handle!.db
      .select()
      .from(importedAgentSessions)
      .where(eq(importedAgentSessions.workspaceId, workspaceId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.decisionStatus).toBe("recorded");
      expect(row.decisionNote).toBe("Fixing the login flake");
      expect(row.rawBlobId).not.toBeNull();
      expect(row.summary.source).toBe(row.source);
    }
    const sources = rows.map((r) => r.source).sort();
    expect(sources).toEqual(["claude-code", "codex"]);

    // One blob row per distinct transcript, and one audit row per session.
    const blobs = await handle!.db
      .select({ id: blobObjects.id })
      .from(blobObjects)
      .where(eq(blobObjects.workspaceId, workspaceId));
    expect(blobs).toHaveLength(2);
    const audits = await handle!.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.action, "agents.external_session_imported")));
    expect(audits).toHaveLength(2);

    // The whole chain ends in a summary no secret reached.
    const dumped = JSON.stringify(rows);
    expect(dumped).not.toContain("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    expect(dumped).not.toContain("hunter2secret");
    expect(dumped).not.toContain("sk-abc123def4567890");
  });

  it("re-scans without duplicating rows, rewriting blobs, or erasing the note", async () => {
    const scan = await collectSessionRecords({ roots });
    const result = await ingestSessionRecords(auth, scan.records, {});
    expect(result.imported).toBe(0);
    expect(result.updated).toBe(2);
    expect(result.blobsDeduped).toBe(2);

    const rows = await handle!.db
      .select()
      .from(importedAgentSessions)
      .where(eq(importedAgentSessions.workspaceId, workspaceId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // A re-scan without a note never erases what a human recorded.
      expect(row.decisionNote).toBe("Fixing the login flake");
      expect(row.decisionStatus).toBe("recorded");
    }

    const blobs = await handle!.db
      .select({ id: blobObjects.id })
      .from(blobObjects)
      .where(eq(blobObjects.workspaceId, workspaceId));
    expect(blobs).toHaveLength(2);
  });

  it("marks a noteless first import as inferred, not recorded", async () => {
    // A brand-new session, imported with no note on this batch.
    const slugDir = join(roots.claudeRoot, "projects", "-home-pino-Polymath");
    writeFileSync(
      join(slugDir, "bbbb2222-2222-3333-4444-555555555555.jsonl"),
      '{"type":"user","uuid":"u-9","sessionId":"sess-later","cwd":"/home/pino/Polymath","timestamp":"2026-11-01T12:00:00.000Z","message":{"role":"user","content":"Second task"}}\n',
    );
    const scan = await collectSessionRecords({ roots });
    expect(scan.records).toHaveLength(3);

    const result = await ingestSessionRecords(auth, scan.records, {});
    expect(result.imported).toBe(1);
    expect(result.updated).toBe(2);

    const rows = await handle!.db
      .select()
      .from(importedAgentSessions)
      .where(eq(importedAgentSessions.workspaceId, workspaceId));
    expect(rows).toHaveLength(3);
    // The scanner keys claude-code sessions by the transcript file stem (the
    // stable identity across replays), not the sessionId field inside.
    const inferred = rows.filter((r) => r.externalSessionId === "bbbb2222-2222-3333-4444-555555555555");
    expect(inferred).toHaveLength(1);
    expect(inferred[0]?.decisionStatus).toBe("inferred");
    expect(inferred[0]?.decisionNote).toBeNull();
    // The two noted sessions kept their note through this noteless batch.
    const stillRecorded = rows.filter((r) => r.externalSessionId !== "bbbb2222-2222-3333-4444-555555555555");
    expect(stillRecorded).toHaveLength(2);
    for (const row of stillRecorded) expect(row.decisionNote).toBe("Fixing the login flake");
  });
});
