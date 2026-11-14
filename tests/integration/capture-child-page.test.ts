import { afterAll, describe, expect, it } from "vitest";
import { captureDocuments, captures } from "@/domains/capture/schema";
import { documentExtractions, documents } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Value: protects=a crawled page opening to read in the inbox with its text;
 * fails_when=a page's text is not returned, a page of another capture or
 * another workspace can be opened through this one, a page whose extraction
 * has not run yet comes back blank, or a very long page is not cut;
 * seam=getCaptureChildPage against real Postgres; no_claim=the rendering
 * (reader component) and the blob fallback for a page with no extraction.
 */

const handle = makeTestDb();

afterAll(async () => {
  await handle.client.end();
});

async function seed(label: string) {
  const seeded = await seedWorkspace(handle.db, `child-${label}-${Date.now()}`);
  const auth = ownerAuth(seeded.userId, seeded.workspaceId);
  const [capture] = await handle.db
    .insert(captures)
    .values({
      workspaceId: auth.workspaceId,
      kind: "url",
      captureMode: "url-reference",
      rawPayload: { url: "https://docs.example/" },
      url: "https://docs.example/",
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  return { auth, capture };
}

async function addPage(
  auth: { workspaceId: string },
  captureId: string,
  input: { title: string; text?: string; position: number },
) {
  const [doc] = await handle.db
    .insert(documents)
    .values({ workspaceId: auth.workspaceId, title: input.title, sourceUrl: `https://docs.example/${input.position}` })
    .returning();
  if (input.text !== undefined) {
    await handle.db.insert(documentExtractions).values({
      workspaceId: auth.workspaceId,
      documentId: doc.id,
      contentHash: crypto.randomUUID(),
      status: "succeeded",
      text: input.text,
    });
  }
  await handle.db
    .insert(captureDocuments)
    .values({ workspaceId: auth.workspaceId, captureId, documentId: doc.id, position: input.position });
  return doc;
}

describe("a link capture's page, opened to read", () => {
  it("returns the page's text, title and address", async () => {
    const { getCaptureChildPage } = await import("@/domains/capture/children");
    const { auth, capture } = await seed("text");
    const doc = await addPage(auth, capture.id, {
      title: "Getting started",
      text: "# Getting started\n\nInstall it.",
      position: 0,
    });
    expect(await getCaptureChildPage(auth, { captureId: capture.id, documentId: doc.id })).toEqual({
      documentId: doc.id,
      title: "Getting started",
      sourceUrl: "https://docs.example/0",
      text: "# Getting started\n\nInstall it.",
      shortened: false,
    });
  });

  it("opens only a child of that capture, in that workspace", async () => {
    const { getCaptureChildPage } = await import("@/domains/capture/children");
    const mine = await seed("mine");
    const other = await seed("other");
    const page = await addPage(mine.auth, mine.capture.id, { title: "Mine", text: "text", position: 0 });
    const stray = await handle.db
      .insert(documents)
      .values({ workspaceId: mine.auth.workspaceId, title: "Not a child", sourceUrl: "https://docs.example/stray" })
      .returning();

    expect(await getCaptureChildPage(other.auth, { captureId: mine.capture.id, documentId: page.id })).toBeNull();
    expect(await getCaptureChildPage(mine.auth, { captureId: other.capture.id, documentId: page.id })).toBeNull();
    expect(await getCaptureChildPage(mine.auth, { captureId: mine.capture.id, documentId: stray[0].id })).toBeNull();
  });

  it("answers null text for a page with nothing to read yet, and cuts a very long one", async () => {
    const { getCaptureChildPage } = await import("@/domains/capture/children");
    const { auth, capture } = await seed("long");
    const bare = await addPage(auth, capture.id, { title: "Unread", position: 0 });
    const long = await addPage(auth, capture.id, { title: "Long", text: "word ".repeat(100_000), position: 1 });
    expect(await getCaptureChildPage(auth, { captureId: capture.id, documentId: bare.id })).toMatchObject({
      text: null,
      shortened: false,
    });
    const page = await getCaptureChildPage(auth, { captureId: capture.id, documentId: long.id });
    expect(page?.text?.length).toBe(200_000);
    expect(page?.shortened).toBe(true);
  });
});
