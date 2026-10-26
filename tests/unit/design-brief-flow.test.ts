import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import {
  BRIEFABLE_KINDS,
  designBriefFromArtifact,
  DesignBriefNotAllowedError,
} from "@/domains/knowledge/design-brief";
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

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
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

    const result = await designBriefFromArtifact(auth, sourceId, { provider: fakeProvider });

    const [brief] = await db.select().from(artifacts).where(eq(artifacts.id, result.briefArtifactId)).limit(1);
    expect(brief?.kind).toBe("memo");
    expect(brief?.status).toBe("generated");
    expect(brief?.title).toBe("Design brief: Launch one-pager");
    const [version] = await db.select().from(artifactVersions).where(eq(artifactVersions.id, brief!.currentVersionId!)).limit(1);
    expect(version?.plainText).toContain("Annual billing stays.");
    expect(version?.plainText).toContain('from "Acme research"');
    expect(result.title).toBe("Design brief: Launch one-pager");
  });

  it("refuses a transcript, pointing at the right tool", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-transcript-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(userId, workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "transcript", "speaker: hello");
    await expect(designBriefFromArtifact(auth, sourceId, { provider: fakeProvider })).rejects.toThrow(DesignBriefNotAllowedError);
    expect(BRIEFABLE_KINDS).not.toContain("transcript");
  });

  it("refuses an artifact with no text", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-empty-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(userId, workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "note", null);
    await expect(designBriefFromArtifact(auth, sourceId, { provider: fakeProvider })).rejects.toThrow(/no text/);
  });

  it("refuses an artifact from another workspace", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-scope-a-${Date.now()}-${process.pid}`);
    const other = await seedWorkspace(db, `brief-scope-b-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(other.userId, other.workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "report", "Secret research.");
    await expect(designBriefFromArtifact(auth, sourceId, { provider: fakeProvider })).rejects.toThrow(/does not exist/);
  });

  it("propagates an unusable model answer without writing anything", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `brief-bad-${Date.now()}-${process.pid}`);
    const auth = ownerAuth(userId, workspaceId);
    const sourceId = await insertSource(workspaceId, userId, "report", "Acme sells annual plans.");
    const bad: GenerationProvider = { name: "fixture:bad", registryId: "fixture", generate: async () => ({ text: "not json" }) };
    await expect(designBriefFromArtifact(auth, sourceId, { provider: bad })).rejects.toThrow(/not JSON/);
    const rows = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.kind, "memo")));
    expect(rows).toHaveLength(0);
  });
});
