import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import type { GenerationProvider } from "@/integrations/generation/provider";

/*
 * The card-to-brief flow against real Postgres: the source artifact's text in,
 * one memo artifact out, provenance in the audit metadata. The provider is a
 * fixture by injection - no model key, no network. Skips locally without
 * TEST_DATABASE_URL; CI treats the missing database as a broken gate.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

let db: NonNullable<typeof handle>["db"];
// The domain module binds DATABASE_URL at import time via @/lib/db, so it is
// imported only after makeTestDb has pointed the scratch database up.
let brief: typeof import("@/domains/knowledge/design-brief");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  brief = await import("@/domains/knowledge/design-brief");
});

afterAll(async () => {
  await handle?.client.end();
});

const BRIEF_JSON = JSON.stringify({
  title: "Launch one-pager",
  objective: "Explain the pricing change.",
  audience: "Current customers.",
  keyMessage: "Annual billing stays.",
  tone: ["plain"],
  format: "doc",
  visualDirection: "Single column, one table.",
  deliverables: ["One-page doc"],
  constraints: null,
  callToAction: null,
});

const fakeProvider: GenerationProvider = {
  name: "fixture:test",
  registryId: "fixture",
  generate: async () => ({ text: BRIEF_JSON }),
};

async function insertSource(workspaceId: string, userId: string, kind: string, text: string | null, title = "Acme research") {
  const [artifact] = await db
    .insert(artifacts)
    .values({ workspaceId, kind: kind as never, title, createdBy: userId, updatedBy: userId })
    .returning({ id: artifacts.id });
  if (text !== null) {
    const [version] = await db
      .insert(artifactVersions)
      .values({ workspaceId, artifactId: artifact.id, versionNumber: 1, content: { text }, plainText: text, reason: "created", createdBy: userId })
      .returning({ id: artifactVersions.id });
    await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
  }
  return artifact.id;
}

suite("designBriefFromArtifact", () => {
  it("turns a research report into a memo brief artifact", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-flow-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(userId, workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "report", "Acme sells annual plans. Customers renew in Q4.");

    const result = await brief.designBriefFromArtifact(auth, sourceId, { provider: fakeProvider });

    const [memo] = await db.select().from(artifacts).where(eq(artifacts.id, result.briefArtifactId)).limit(1);
    expect(memo?.kind).toBe("memo");
    expect(memo?.status).toBe("generated");
    expect(memo?.title).toBe("Design brief: Launch one-pager");
    const [version] = await db.select().from(artifactVersions).where(eq(artifactVersions.id, memo!.currentVersionId!)).limit(1);
    expect(version?.plainText).toContain("Annual billing stays.");
    expect(version?.plainText).toContain('from "Acme research"');
    expect(result.title).toBe("Design brief: Launch one-pager");
    expect(result.existing).toBe(false);
  });

  it("a repeat click returns the existing brief instead of writing a duplicate", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-idem-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(userId, workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "report", "Acme sells annual plans. Customers renew in Q4.");

    const first = await brief.designBriefFromArtifact(auth, sourceId, { provider: fakeProvider });
    const second = await brief.designBriefFromArtifact(auth, sourceId, { provider: fakeProvider });

    expect(first.existing).toBe(false);
    expect(second.existing).toBe(true);
    expect(second.briefArtifactId).toBe(first.briefArtifactId);
    const memos = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.kind, "memo")));
    expect(memos).toHaveLength(1);
  });

  it("two concurrent first clicks produce exactly one brief", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-race-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(userId, workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "report", "Acme sells annual plans. Customers renew in Q4.");

    const [a, b] = await Promise.all([
      brief.designBriefFromArtifact(auth, sourceId, { provider: fakeProvider }),
      brief.designBriefFromArtifact(auth, sourceId, { provider: fakeProvider }),
    ]);

    expect(a.briefArtifactId).toBe(b.briefArtifactId);
    expect(a.existing).not.toBe(b.existing);
    const memos = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.kind, "memo")));
    expect(memos).toHaveLength(1);
  });

  it("an edited source drafts a fresh brief rather than reusing a stale one", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-rev-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(userId, workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "report", "Acme sells annual plans.");

    const first = await brief.designBriefFromArtifact(auth, sourceId, { provider: fakeProvider });

    const [v2] = await db
      .insert(artifactVersions)
      .values({ workspaceId, artifactId: sourceId, versionNumber: 2, content: { text: "Acme now sells monthly plans too." }, plainText: "Acme now sells monthly plans too.", reason: "edited", createdBy: userId })
      .returning({ id: artifactVersions.id });
    await db.update(artifacts).set({ currentVersionId: v2.id }).where(eq(artifacts.id, sourceId));

    const second = await brief.designBriefFromArtifact(auth, sourceId, { provider: fakeProvider });

    expect(second.existing).toBe(false);
    expect(second.briefArtifactId).not.toBe(first.briefArtifactId);
    const memos = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.kind, "memo")));
    expect(memos).toHaveLength(2);
  });

  it("refuses plainly when no generation provider is configured, writing nothing", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-unconf-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(userId, workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "report", "Acme sells annual plans.");

    const KEYS = ["GENERATION_PROVIDER", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] as const;
    const saved = KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of KEYS) delete process.env[k];
    try {
      await expect(brief.designBriefFromArtifact(auth, sourceId)).rejects.toThrow(/No generation provider configured/);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const memos = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.kind, "memo")));
    expect(memos).toHaveLength(0);
  });

  it("refuses a transcript, pointing at the right tool", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-transcript-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(userId, workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "transcript", "speaker: hello");
    await expect(brief.designBriefFromArtifact(auth, sourceId, { provider: fakeProvider })).rejects.toThrow(brief.DesignBriefNotAllowedError);
    expect(brief.BRIEFABLE_KINDS).not.toContain("transcript");
  });

  it("refuses an artifact with no text", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-empty-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(userId, workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "note", null);
    await expect(brief.designBriefFromArtifact(auth, sourceId, { provider: fakeProvider })).rejects.toThrow(/no text/);
  });

  it("refuses an artifact from another workspace", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-scope-a-${Date.now()}-${process.pid}`);
    const other = await seedWorkspace(db, `brief-scope-b-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(other.userId, other.workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "report", "Secret research.");
    await expect(brief.designBriefFromArtifact(auth, sourceId, { provider: fakeProvider })).rejects.toThrow(/does not exist/);
  });

  it("propagates an unusable model answer without writing anything", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-bad-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(userId, workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "report", "Acme sells annual plans.");
    const bad: GenerationProvider = { name: "fixture:bad", registryId: "fixture", generate: async () => ({ text: "not json" }) };
    await expect(brief.designBriefFromArtifact(auth, sourceId, { provider: bad })).rejects.toThrow(/not JSON/);
    const rows = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.kind, "memo")));
    expect(rows).toHaveLength(0);
  });

  /*
   * TD-10: the model call must not run inside a transaction. Holding one open
   * across a provider call pins a Neon connection for the whole generation, and
   * a few concurrent clicks exhaust the pool for unrelated requests. The
   * provider is the only place that can observe it: while it runs, it asks
   * Postgres how many backends on this database are sitting inside a
   * transaction. A transaction wrapped around the call shows one.
   */
  it("calls the provider with no transaction open on this database", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-tx-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(userId, workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "report", "Acme sells annual plans.");

    let openTransactions = -1;
    const observing: GenerationProvider = {
      name: "fixture:tx-observer",
      registryId: "fixture",
      generate: async () => {
        const rows = await db.execute(sql`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database()
            and state in ('idle in transaction', 'idle in transaction (aborted)')
        `);
        openTransactions = (rows as unknown as Array<{ n: number }>)[0]?.n ?? -1;
        return { text: BRIEF_JSON };
      },
    };

    const result = await brief.designBriefFromArtifact(auth, sourceId, { provider: observing });

    expect(openTransactions).toBe(0);
    // The write still commits after the reorder: one memo, its version, its audit row.
    const [memo] = await db.select().from(artifacts).where(eq(artifacts.id, result.briefArtifactId)).limit(1);
    expect(memo?.currentVersionId).toBeTruthy();
    const [audit] = await db.execute(sql`
      select count(*)::int as n from audit_events
      where workspace_id = ${workspaceId} and action = 'knowledge.design_brief.generated'
    `) as unknown as Array<{ n: number }>;
    expect(audit?.n).toBe(1);
  });
});
