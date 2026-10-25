import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifactLinks, artifacts, artifactVersions, documents } from "@/domains/knowledge/schema";
import { makeTestDb, seedWorkspace, ownerAuth } from "../helpers/test-workspace";

/*
 * "Shown what I already wrote about it" (Product Spec, Capture stories):
 * listPriorWritingForUrl collects, for one URL, the cards the graph says came
 * from that page (source edges) and the notes/zettels that mention the link -
 * tenant-scoped, unarchived, never listing one card twice, and matching the
 * document by the same canonical form capture-url writes.
 */

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

import { createNote } from "@/domains/knowledge/notes";
import { listPriorWritingForUrl } from "@/domains/knowledge/prior-writing";

const CANONICAL = "https://example.com/essays/idea-atoms";
const RAW = "https://example.com/essays/idea-atoms?utm_source=newsletter#part-2";

beforeAll(() => {
  holder.db = handle?.db;
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterAll(async () => { vi.unstubAllEnvs(); await handle?.client.end(); });

async function addDocument(db: NonNullable<typeof holder.db>, ws: string, userId: string, sourceUrl: string) {
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId: ws, title: "Idea atoms", sourceUrl, createdBy: userId, updatedBy: userId })
    .returning({ id: documents.id });
  return doc.id;
}

async function addSourcedCard(
  db: NonNullable<typeof holder.db>,
  ws: string,
  userId: string,
  input: { title: string; text: string; documentId: string; archived?: boolean },
) {
  const [card] = await db
    .insert(artifacts)
    .values({ workspaceId: ws, kind: "zettel", title: input.title, status: "reviewed", createdBy: userId, updatedBy: userId, ...(input.archived ? { archivedAt: new Date() } : {}) })
    .returning({ id: artifacts.id });
  const [version] = await db
    .insert(artifactVersions)
    .values({
      workspaceId: ws,
      artifactId: card.id,
      versionNumber: 1,
      content: { format: "markdown", text: input.text },
      plainText: input.text,
      reason: "created",
      createdBy: userId,
    })
    .returning({ id: artifactVersions.id });
  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, card.id));
  await db.insert(artifactLinks).values({
    workspaceId: ws,
    artifactId: card.id,
    targetType: "document",
    targetId: input.documentId,
    label: "Idea atoms",
    linkType: "source",
  });
  return card.id;
}

suite("listPriorWritingForUrl", () => {
  it("shows zettels sourced from the page and notes mentioning the link, matched canonically", async () => {
    const db = holder.db!;
    const { userId, workspaceId } = await seedWorkspace(db, `pw-main-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const documentId = await addDocument(db, workspaceId, userId, CANONICAL);
    const zettelId = await addSourcedCard(db, workspaceId, userId, {
      title: "Ideas are atoms",
      text: "A big idea is small ideas joined.\n\n> atoms",
      documentId,
    });
    const note = await createNote(auth, {
      idempotencyKey: crypto.randomUUID(),
      title: "Reading log",
      plainText: `Worth rereading: ${RAW}\nMore thoughts later.`,
    });

    const result = await listPriorWritingForUrl(auth, { url: RAW });

    expect(result.documentId).toBe(documentId);
    const fromPage = result.items.filter((item) => item.basis === "from-page");
    const mentions = result.items.filter((item) => item.basis === "mentions");
    expect(fromPage.map((item) => item.id)).toEqual([zettelId]);
    expect(fromPage[0].kind).toBe("zettel");
    expect(fromPage[0].excerpt).toBe("A big idea is small ideas joined.");
    expect(mentions.map((item) => item.id)).toEqual([note.id]);
  });

  it("never lists one card twice: a sourced card that also contains the URL stays from-page only", async () => {
    const db = holder.db!;
    const { userId, workspaceId } = await seedWorkspace(db, `pw-overlap-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const documentId = await addDocument(db, workspaceId, userId, CANONICAL);
    const zettelId = await addSourcedCard(db, workspaceId, userId, {
      title: "Self-quoting zettel",
      text: `From ${RAW} - atoms again.`,
      documentId,
    });

    const result = await listPriorWritingForUrl(auth, { url: RAW });

    expect(result.items.map((item) => item.id)).toEqual([zettelId]);
    expect(result.items[0].basis).toBe("from-page");
  });

  it("hides other workspaces' documents and cards", async () => {
    const db = holder.db!;
    const mine = await seedWorkspace(db, `pw-mine-${Date.now()}`);
    const theirs = await seedWorkspace(db, `pw-theirs-${Date.now()}`);
    const theirDoc = await addDocument(db, theirs.workspaceId, theirs.userId, CANONICAL);
    await addSourcedCard(db, theirs.workspaceId, theirs.userId, { title: "Their zettel", text: "Theirs.", documentId: theirDoc });

    const result = await listPriorWritingForUrl(ownerAuth(mine.userId, mine.workspaceId), { url: RAW });

    expect(result).toEqual({ documentId: null, items: [] });
  });

  it("hides archived cards even when the graph still points at them", async () => {
    const db = holder.db!;
    const { userId, workspaceId } = await seedWorkspace(db, `pw-arch-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const documentId = await addDocument(db, workspaceId, userId, CANONICAL);
    await addSourcedCard(db, workspaceId, userId, { title: "Old zettel", text: "Gone.", documentId, archived: true });

    const result = await listPriorWritingForUrl(auth, { url: RAW });

    expect(result.documentId).toBe(documentId);
    expect(result.items).toEqual([]);
  });

  it("returns empty when nothing matches, and never throws on a non-URL", async () => {
    const db = holder.db!;
    const { userId, workspaceId } = await seedWorkspace(db, `pw-empty-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    expect(await listPriorWritingForUrl(auth, { url: "https://never-captured.example.com/x" })).toEqual({ documentId: null, items: [] });
    expect(await listPriorWritingForUrl(auth, { url: "not a url at all" })).toEqual({ documentId: null, items: [] });
    expect(await listPriorWritingForUrl(auth, { url: "ftp://old.example.com/file" })).toEqual({ documentId: null, items: [] });
  });
});
