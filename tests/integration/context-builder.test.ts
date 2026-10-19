import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifacts, artifactVersions, claimEvidence, claims, sources } from "@/domains/knowledge/schema";
import {
  agentProfiles,
  contextManifestItems,
  contextManifests,
  memoryItems,
  memoryRevisions,
  messages,
  threads,
} from "@/domains/agents/schema";
import { buildContext, loadManifest, validateClaimEvidence } from "@/domains/agents/services/context-builder";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-118 acceptance coverage on a real Postgres: tenancy, accepted-only
 * memory, superseded versions, live revocation, evidence validation, and
 * budget truncation are all stateful behaviors a mock cannot prove.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

let ws: { userId: string; workspaceId: string };
let other: { userId: string; workspaceId: string };

async function makeArtifactWithVersions(title: string) {
  const [artifact] = await holder.db!.insert(artifacts).values({ workspaceId: ws.workspaceId, title }).returning();
  const [v1] = await holder.db!
    .insert(artifactVersions)
    .values({ workspaceId: ws.workspaceId, artifactId: artifact.id, versionNumber: 1, content: {}, plainText: `${title} v1 body` })
    .returning();
  const [v2] = await holder.db!
    .insert(artifactVersions)
    .values({ workspaceId: ws.workspaceId, artifactId: artifact.id, versionNumber: 2, content: {}, plainText: `${title} v2 body` })
    .returning();
  await holder.db!.update(artifacts).set({ currentVersionId: v2.id }).where(eq(artifacts.id, artifact.id));
  return { artifact, v1, v2 };
}

async function makeMemory(status: "proposed" | "accepted" | "rejected" | "retired", body: string) {
  const [item] = await holder.db!.insert(memoryItems).values({ workspaceId: ws.workspaceId, body, status }).returning();
  const [rev] = await holder.db!.insert(memoryRevisions).values({ workspaceId: ws.workspaceId, memoryItemId: item.id, body }).returning();
  return { item, rev };
}

async function makeClaimedEvidence() {
  const [source] = await holder.db!
    .insert(sources).values({ workspaceId: ws.workspaceId, kind: "web", url: `https://example.com/${Date.now()}`, contentHash: `h${Date.now()}` })
    .returning();
  const [claim] = await holder.db!
    .insert(claims).values({ workspaceId: ws.workspaceId, statement: "The price is 42 USD", status: "accepted" })
    .returning();
  const [ev] = await holder.db!
    .insert(claimEvidence)
    .values({ workspaceId: ws.workspaceId, claimId: claim.id, sourceId: source.id, quote: "price: 42 USD", startOffset: 10, endOffset: 24 })
    .returning();
  return { source, claim, ev };
}

beforeAll(async () => {
  holder.db = handle?.db;
  ws = await seedWorkspace(handle!.db, `rt04a${Date.now() % 100000}`);
  other = await seedWorkspace(handle!.db, `rt04b${Date.now() % 100000}`);
});
afterAll(async () => { await handle?.client.end(); });

suite("buildContext", () => {
  it("pins the versions actually used and marks a superseded pinned version", async () => {
    const { v1, v2 } = await makeArtifactWithVersions(`t-${Date.now()}`);
    const built = await buildContext({
      workspaceId: ws.workspaceId,
      purpose: "test",
      artifactVersionIds: [v1.id, v2.id],
    });
    const byRef = new Map(built.items.map((i) => [i.refId, i]));
    expect(byRef.get(v1.id)?.staleness).toBe("superseded"); // historical evidence, not current truth
    expect(byRef.get(v2.id)?.staleness).toBe("current");
    expect(byRef.get(v1.id)?.refVersion).toBe(1);
    const [manifest] = await holder.db!.select().from(contextManifests).where(eq(contextManifests.id, built.manifestId));
    expect(manifest.itemCount).toBe(2);
    expect((manifest.budget as { truncated: boolean }).truncated).toBe(false);
  });

  it("unauthorized records never enter context: foreign and missing ids are recorded gaps", async () => {
    const [foreignArtifact] = await holder.db!.insert(artifacts).values({ workspaceId: other.workspaceId, title: "foreign" }).returning();
    const [foreignV] = await holder.db!
      .insert(artifactVersions)
      .values({ workspaceId: other.workspaceId, artifactId: foreignArtifact.id, versionNumber: 1, content: {}, plainText: "secret" })
      .returning();
    const built = await buildContext({
      workspaceId: ws.workspaceId,
      purpose: "test",
      artifactVersionIds: [foreignV.id, "00000000-0000-0000-0000-000000000000"],
    });
    expect(built.items).toHaveLength(0);
    expect(built.gaps).toHaveLength(2);
    expect(built.gaps.every((g) => g.reason === "not found in workspace")).toBe(true); // no cross-workspace hint
    expect(JSON.stringify(built)).not.toContain("secret");
  });

  it("only accepted memory enters context; proposed/rejected/retired are gaps", async () => {
    const accepted = await makeMemory("accepted", "prefers concise replies");
    const proposed = await makeMemory("proposed", "maybe likes coffee");
    const rejected = await makeMemory("rejected", "not a preference");
    const retired = await makeMemory("retired", "outdated fact");
    const built = await buildContext({
      workspaceId: ws.workspaceId,
      purpose: "test",
      memoryItemIds: [accepted.item.id, proposed.item.id, rejected.item.id, retired.item.id],
    });
    expect(built.items).toHaveLength(1);
    expect(built.items[0].text).toBe("prefers concise replies");
    expect(built.gaps).toHaveLength(3);
    expect(built.gaps.map((g) => g.reason).join()).toContain("not accepted");
  });

  it("conversation history is bounded and typed as message, never evidence", async () => {
    const [profile] = await holder.db!.insert(agentProfiles).values({ workspaceId: ws.workspaceId, name: `p-${Date.now()}` }).returning();
    const [thread] = await holder.db!.insert(threads).values({ workspaceId: ws.workspaceId, agentProfileId: profile.id }).returning();
    for (let i = 0; i < 5; i++) {
      await holder.db!.insert(messages).values({ workspaceId: ws.workspaceId, threadId: thread.id, role: i % 2 ? "assistant" : "user", content: `m${i}` });
    }
    const built = await buildContext({ workspaceId: ws.workspaceId, purpose: "test", threadId: thread.id, maxMessages: 3 });
    expect(built.items).toHaveLength(3);
    expect(built.items.every((i) => i.kind === "message")).toBe(true);
    expect(built.items.map((i) => i.text)).toEqual(["m2", "m3", "m4"]); // most recent, chronological
  });

  it("the budget truncates by exclusion with a recorded reason", async () => {
    const a1 = await makeArtifactWithVersions(`big1-${Date.now()}`);
    const a2 = await makeArtifactWithVersions(`big2-${Date.now()}`);
    const built = await buildContext({
      workspaceId: ws.workspaceId,
      purpose: "test",
      artifactVersionIds: [a1.v2.id, a2.v2.id],
      maxTokens: 4, // fits the ~20-char first body only... neither fits fully? bodies are ~14 chars => 4 tokens each, fits one
    });
    expect(built.truncated).toBe(true);
    expect(built.gaps.some((g) => g.reason === "excluded by context budget")).toBe(true);
    const [manifest] = await holder.db!.select().from(contextManifests).where(eq(contextManifests.id, built.manifestId));
    expect(manifest.gapCount).toBeGreaterThan(0);
  });
});

suite("loadManifest live revocation", () => {
  it("revoked material becomes a gap on load; the stored manifest is unchanged", async () => {
    const { artifact, v2 } = await makeArtifactWithVersions(`rev-${Date.now()}`);
    const accepted = await makeMemory("accepted", "fact to retire");
    const built = await buildContext({
      workspaceId: ws.workspaceId,
      purpose: "test",
      artifactVersionIds: [v2.id],
      memoryItemIds: [accepted.item.id],
    });
    // Revoke after construction: archive the artifact, retire the memory.
    await holder.db!.update(artifacts).set({ archivedAt: new Date() }).where(eq(artifacts.id, artifact.id));
    await holder.db!.update(memoryItems).set({ status: "retired" }).where(eq(memoryItems.id, accepted.item.id));

    const loaded = await loadManifest(built.manifestId, ws.workspaceId);
    expect(loaded).not.toBeNull();
    expect(loaded!.items).toHaveLength(0);
    expect(loaded!.gaps).toHaveLength(2);
    // History is preserved: the manifest rows still record what was used.
    const stored = await holder.db!.select().from(contextManifestItems).where(eq(contextManifestItems.manifestId, built.manifestId));
    expect(stored.filter((r) => r.included)).toHaveLength(2);
  });
});

suite("validateClaimEvidence", () => {
  it("distinguishes source-backed claims from unsupported inference and malformed spans", async () => {
    const { claim, source } = await makeClaimedEvidence();
    const [unsupported] = await holder.db!
      .insert(claims).values({ workspaceId: ws.workspaceId, statement: "invented agreement", status: "proposed" })
      .returning();
    const [malformedClaim] = await holder.db!
      .insert(claims).values({ workspaceId: ws.workspaceId, statement: "bad span", status: "proposed" })
      .returning();
    await holder.db!.insert(claimEvidence).values({
      workspaceId: ws.workspaceId, claimId: malformedClaim.id, sourceId: source.id, quote: "x", startOffset: 50, endOffset: 10,
    });

    const results = await validateClaimEvidence([claim.id, unsupported.id, malformedClaim.id], ws.workspaceId);
    const byId = new Map(results.map((r) => [r.claimId, r]));
    expect(byId.get(claim.id)?.supported).toBe(true);
    expect(byId.get(unsupported.id)?.supported).toBe(false);
    expect(byId.get(unsupported.id)?.reason).toBe("no accessible source evidence");
    expect(byId.get(malformedClaim.id)?.supported).toBe(false);
    expect(byId.get(malformedClaim.id)?.spans[0].malformed).toBe(true);
  });

  it("a claim from another workspace is not found, not leaked", async () => {
    const { claim } = await makeClaimedEvidence();
    const results = await validateClaimEvidence([claim.id], other.workspaceId);
    expect(results[0].supported).toBe(false);
    expect(results[0].reason).toBe("claim not found in workspace");
  });
});
