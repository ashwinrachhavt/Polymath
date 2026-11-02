import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifactLinks, artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Task 22: link rationale is written on demand, once. Ingest and linking stay
 * free; the first explainLink call generates and stores context, and every
 * later call reads the stored sentence without a model call.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

import { explainLink } from "@/domains/knowledge/link-rationale";
import type { GenerationProvider } from "@/integrations/generation/provider";

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

const workspace = async () => {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `rationale-${crypto.randomUUID()}`);
  return ownerAuth(userId, workspaceId);
};

/** A note artifact with one version whose plainText is the claim. */
async function claimArtifact(workspaceId: string, title: string, text: string): Promise<string> {
  const db = holder.db!;
  const [row] = await db.insert(artifacts).values({ workspaceId, kind: "note", title }).returning({ id: artifacts.id });
  const [version] = await db
    .insert(artifactVersions)
    .values({
      workspaceId,
      artifactId: row.id,
      versionNumber: 1,
      content: { type: "doc", content: [] },
      plainText: text,
    })
    .returning({ id: artifactVersions.id });
  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, row.id));
  return row.id;
}

async function seedLink(workspaceId: string, a: string, b: string): Promise<string> {
  const [row] = await holder
    .db!.insert(artifactLinks)
    .values({ workspaceId, artifactId: a, targetType: "note", targetId: b, label: "linked", linkType: "related" })
    .returning({ id: artifactLinks.id });
  return row.id;
}

const storedContext = async (linkId: string): Promise<string | null> => {
  const [row] = await holder
    .db!.select({ context: artifactLinks.context })
    .from(artifactLinks)
    .where(eq(artifactLinks.id, linkId));
  return row?.context ?? null;
};

suite("link rationale (real Postgres)", () => {
  it("no rationale is written until explainLink is called", async () => {
    const auth = await workspace();
    const a = await claimArtifact(auth.workspaceId, "Retries improve reliability", "Retries raise success rates.");
    const b = await claimArtifact(
      auth.workspaceId,
      "Retries need idempotency",
      "Retries are safe only when effects are deduplicated.",
    );
    const linkId = await seedLink(auth.workspaceId, a, b);
    expect(await storedContext(linkId)).toBeNull();
  });

  it("explainLink generates, stores, and returns the rationale", async () => {
    const auth = await workspace();
    const a = await claimArtifact(auth.workspaceId, "Retries improve reliability", "Retries raise success rates.");
    const b = await claimArtifact(
      auth.workspaceId,
      "Retries need idempotency",
      "Retries are safe only when effects are deduplicated.",
    );
    const linkId = await seedLink(auth.workspaceId, a, b);
    const generate = vi.fn(async () => ({
      text: "  The second qualifies the first: retries assume deduplicated effects.  ",
    }));
    const provider: GenerationProvider = { name: "fake-rationale", registryId: "fake", generate };
    const out = await explainLink(auth, { linkId, provider });
    expect(out.context).toContain("deduplicated effects");
    expect(out.context.startsWith("The second")).toBe(true);
    expect(await storedContext(linkId)).toBe(out.context);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("a second call returns the stored value without invoking the provider again", async () => {
    const auth = await workspace();
    const a = await claimArtifact(auth.workspaceId, "First claim", "first claim body");
    const b = await claimArtifact(auth.workspaceId, "Second claim", "second claim body");
    const linkId = await seedLink(auth.workspaceId, a, b);
    const generate = vi.fn(async () => ({ text: "One sentence." }));
    const provider: GenerationProvider = { name: "fake-rationale", registryId: "fake", generate };
    const first = await explainLink(auth, { linkId, provider });
    const second = await explainLink(auth, { linkId, provider });
    expect(second.context).toBe(first.context);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("an empty generation never writes a rationale", async () => {
    const auth = await workspace();
    const a = await claimArtifact(auth.workspaceId, "First claim", "first claim body");
    const b = await claimArtifact(auth.workspaceId, "Second claim", "second claim body");
    const linkId = await seedLink(auth.workspaceId, a, b);
    const provider: GenerationProvider = {
      name: "fake-rationale",
      registryId: "fake",
      generate: async () => ({ text: "   " }),
    };
    await expect(explainLink(auth, { linkId, provider })).rejects.toThrow(/rationale/i);
    expect(await storedContext(linkId)).toBeNull();
  });
});
