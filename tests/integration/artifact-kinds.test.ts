import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { agentProfiles, agentRuns, runEvents } from "@/domains/agents/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import {
  GENERATABLE_KINDS,
  editGeneratedDraft,
  getDraftDetail,
  isGeneratableKind,
  saveGeneratedDraft,
} from "@/domains/knowledge/studio";

/*
 * A deck and an infographic are the same container as a report. Before the
 * kind widening, saveGeneratedDraft filed everything as "report" and
 * getDraftDetail refused anything that was not "report" — so a generated deck
 * was misfiled and then unopenable. These tests pin both halves.
 */

suite("generatable draft kinds (Neon)", () => {
  let auth: ReturnType<typeof ownerAuth>;

  async function succeededRun(objective: string, content?: string): Promise<string> {
    const [profile] = await holder.db!
      .insert(agentProfiles)
      .values({ workspaceId: auth.workspaceId, name: "polymath", createdBy: auth.userId, updatedBy: auth.userId })
      .onConflictDoNothing()
      .returning();
    const profileId = profile?.id ?? (await holder.db!.select({ id: agentProfiles.id }).from(agentProfiles).where(eq(agentProfiles.workspaceId, auth.workspaceId)).limit(1))[0].id;
    const [run] = await holder.db!
      .insert(agentRuns)
      .values({ workspaceId: auth.workspaceId, agentProfileId: profileId, objective, policySnapshot: {}, state: "succeeded", createdBy: auth.userId, updatedBy: auth.userId })
      .returning();
    await holder.db!.insert(runEvents).values({
      workspaceId: auth.workspaceId,
      runId: run.id,
      sequence: 1,
      type: "message",
      data: { role: "assistant", content: content ?? `# ${objective}\n\nA generated body.` },
    });
    return run.id;
  }

  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
    const seed = await seedWorkspace(handle.db, `kinds-${Date.now()}`);
    auth = ownerAuth(seed.userId, seed.workspaceId);
  });

  it("isGeneratableKind accepts exactly the three generated kinds", () => {
    expect([...GENERATABLE_KINDS]).toEqual(["report", "deck", "infographic"]);
    expect(isGeneratableKind("deck")).toBe(true);
    expect(isGeneratableKind("infographic")).toBe(true);
    expect(isGeneratableKind("note")).toBe(false);
    expect(isGeneratableKind("other")).toBe(false);
  });

  it("saves a deck with kind deck, not report", async () => {
    if (!handle) return;
    const runId = await succeededRun(
      "deck: study guide",
      JSON.stringify({ slides: [{ title: "deck: study guide", bullets: ["A generated body."], citations: [] }] }),
    );
    const { artifactId } = await saveGeneratedDraft(auth, { runId, kind: "deck" });
    const [row] = await holder.db!.select({ kind: artifacts.kind }).from(artifacts).where(eq(artifacts.id, artifactId));
    expect(row.kind).toBe("deck");
  });

  it("opens and edits a saved infographic", async () => {
    if (!handle) return;
    const runId = await succeededRun(
      "infographic: key numbers",
      JSON.stringify({
        headline: "infographic: key numbers",
        layout: "sections",
        sections: [{ heading: "key numbers", body: "A generated body." }],
        citations: [],
      }),
    );
    const { artifactId } = await saveGeneratedDraft(auth, { runId, kind: "infographic" });
    const detail = (await getDraftDetail(auth, artifactId))!;
    expect(detail.artifact.status).toBe("draft");
    expect(detail.text).toContain("key numbers");
    const edited = await editGeneratedDraft(auth, {
      artifactId,
      expectedVersion: detail.artifact.version,
      structured: { kind: "infographic", headline: "An edited infographic body.", layout: "lede", stats: [], sections: [], citations: [] },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(edited.version).toBe(detail.artifact.version + 1);
    const [version] = await holder.db!
      .select({ plainText: artifactVersions.plainText })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, artifactId))
      .orderBy(artifactVersions.versionNumber)
      .limit(1);
    expect(version.plainText).toContain("generated body");
  });

  it("still refuses a kind Studio does not generate", async () => {
    if (!handle) return;
    const runId = await succeededRun("note-like thing");
    await expect(saveGeneratedDraft(auth, { runId, kind: "note" as never })).rejects.toThrow(/not generated here/);
  });
});
