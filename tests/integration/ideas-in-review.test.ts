import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { artifacts, artifactVersions, documents, files, zettelProposals } from "@/domains/knowledge/schema";
import type { ExtractionResult } from "@/integrations/extraction/provider";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The Ideas "In review" queue (spec §7 B4): pending proposals from BOTH source
 * kinds — document extractions and filed conversations — appear in one list
 * with their source titles, scoped to the workspace; and a decision (accept
 * or reject) removes the row, so the queue drains itself.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
const extract = vi.hoisted(() => ({ extract: vi.fn<() => Promise<ExtractionResult>>() }));
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("@/integrations/extraction/docling-docker", () => ({ createDoclingDockerProvider: () => extract }));
vi.mock("@/integrations/object-store/object-store", () => ({
  readBlob: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
}));

import { extractDocument } from "@/domains/knowledge/extraction";
import { acceptZettel, listPendingZettelProposals, proposeZettels, rejectZettel } from "@/domains/knowledge/zettels";
import type { ZettelExtractor } from "@/integrations/zettels/extractor";

const TEXT = "The tenant pays monthly rent of twelve hundred dollars.";
const Q1 = "The tenant pays monthly rent of twelve hundred dollars.";

const extractor = (cands: Array<{ title: string; claim: string; quote: string }>): ZettelExtractor => ({
  name: "fake@1",
  extract: async () => cands,
});

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DOCLING_SERVE_URL", "http://docling.fixture");
});

async function seedDocumentProposal(auth: ReturnType<typeof ownerAuth>) {
  const db = holder.db!;
  const [blob] = await db
    .insert(blobObjects)
    .values({
      workspaceId: auth.workspaceId,
      storageKey: `private/${crypto.randomUUID()}`,
      contentHash: crypto.randomUUID(),
      sizeBytes: 4,
      mimeType: "application/pdf",
    })
    .returning();
  const [file] = await db
    .insert(files)
    .values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: "lease.pdf" })
    .returning();
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId: auth.workspaceId, title: "Lease", fileId: file.id, mimeType: "application/pdf" })
    .returning();
  extract.extract.mockResolvedValueOnce({
    ok: true,
    text: TEXT,
    spans: [{ page: 1, start: 0, end: TEXT.length }],
    pageCount: 1,
    extractor: "fixture@1",
  });
  const r = await extractDocument({ ...auth, role: "owner" as const }, { documentId: doc.id });
  if (!r.ok) throw new Error("seed failed");
  const { proposals } = await proposeZettels(auth, {
    documentId: doc.id,
    extractor: extractor([{ title: "Monthly rent", claim: "Rent is $1,200 a month.", quote: Q1 }]),
  });
  return { doc, proposal: proposals[0] };
}

async function seedArtifactProposal(auth: ReturnType<typeof ownerAuth>, title = "Lease chat") {
  const db = holder.db!;
  const [artifact] = await db
    .insert(artifacts)
    .values({
      workspaceId: auth.workspaceId,
      kind: "note",
      title,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  const [version] = await db
    .insert(artifactVersions)
    .values({
      workspaceId: auth.workspaceId,
      artifactId: artifact.id,
      versionNumber: 1,
      content: { format: "markdown", text: TEXT },
      plainText: TEXT,
      reason: "created",
      createdBy: auth.userId,
    })
    .returning();
  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
  const { proposals } = await proposeZettels(auth, {
    sourceArtifactId: artifact.id,
    extractor: extractor([{ title: "Deposit rule", claim: "The deposit is held.", quote: Q1 }]),
  });
  return { artifact, proposal: proposals[0] };
}

suite("listPendingZettelProposals (real Postgres)", () => {
  it("lists pending proposals from both source kinds with their source titles", async () => {
    const seed = await seedWorkspace(holder.db!, `ir-${crypto.randomUUID()}`);
    const auth = ownerAuth(seed.userId, seed.workspaceId);
    await seedDocumentProposal(auth);
    await seedArtifactProposal(auth);

    const pending = await listPendingZettelProposals(auth);

    expect(pending).toHaveLength(2);
    const byKind = new Map(pending.map((p) => [p.source.kind, p]));
    expect(byKind.get("document")).toMatchObject({
      title: "Monthly rent",
      claim: "Rent is $1,200 a month.",
      source: { kind: "document", title: "Lease" },
    });
    expect(byKind.get("artifact")).toMatchObject({
      title: "Deposit rule",
      claim: "The deposit is held.",
      source: { kind: "artifact", title: "Lease chat" },
    });
  });

  it("orders newest first", async () => {
    const seed = await seedWorkspace(holder.db!, `ir-${crypto.randomUUID()}`);
    const auth = ownerAuth(seed.userId, seed.workspaceId);
    const doc = await seedDocumentProposal(auth);
    const art = await seedArtifactProposal(auth);
    const db = holder.db!;
    await db
      .update(zettelProposals)
      .set({ createdAt: new Date("2026-01-02T00:00:00Z") })
      .where(eq(zettelProposals.id, doc.proposal.id));
    await db
      .update(zettelProposals)
      .set({ createdAt: new Date("2026-01-03T00:00:00Z") })
      .where(eq(zettelProposals.id, art.proposal.id));

    const pending = await listPendingZettelProposals(auth);

    expect(pending.map((p) => p.title)).toEqual(["Deposit rule", "Monthly rent"]);
  });

  it("a decision removes the proposal from the queue and an accept leaves the zettel card", async () => {
    const seed = await seedWorkspace(holder.db!, `ir-${crypto.randomUUID()}`);
    const auth = ownerAuth(seed.userId, seed.workspaceId);
    const doc = await seedDocumentProposal(auth);
    const art = await seedArtifactProposal(auth);

    await rejectZettel(auth, { proposalId: art.proposal.id });
    expect(await listPendingZettelProposals(auth)).toHaveLength(1);

    await acceptZettel(auth, { proposalId: doc.proposal.id });
    expect(await listPendingZettelProposals(auth)).toHaveLength(0);

    const db = holder.db!;
    const cards = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "zettel")));
    expect(cards).toHaveLength(1);
  });

  it("never shows another workspace's queue", async () => {
    const db = holder.db!;
    const seed = await seedWorkspace(db, `ir-${crypto.randomUUID()}`);
    const auth = ownerAuth(seed.userId, seed.workspaceId);
    await seedArtifactProposal(auth);

    const other = await seedWorkspace(db, `ir-${crypto.randomUUID()}`);
    const otherAuth = ownerAuth(other.userId, other.workspaceId);
    const [otherArtifact] = await db
      .insert(artifacts)
      .values({
        workspaceId: otherAuth.workspaceId,
        kind: "note",
        title: "Other chat",
        createdBy: otherAuth.userId,
        updatedBy: otherAuth.userId,
      })
      .returning();
    await db.insert(zettelProposals).values({
      workspaceId: otherAuth.workspaceId,
      sourceArtifactId: otherArtifact.id,
      title: "Other proposal",
      claim: "A claim from another workspace.",
      quote: Q1,
      spanStart: 0,
      spanEnd: Q1.length,
      dedupeKey: `other-${crypto.randomUUID()}`,
    });

    const pending = await listPendingZettelProposals(auth);

    expect(pending).toHaveLength(1);
    expect(pending[0].title).toBe("Deposit rule");
  });
});
