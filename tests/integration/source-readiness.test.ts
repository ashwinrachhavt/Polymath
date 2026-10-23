import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

import { documentExtractions, documents } from "@/domains/knowledge/schema";
import { listSources } from "@/domains/knowledge/source-readiness";

/*
 * The Sources pane's readiness projection, on the failure labels: a fetch-class
 * failure (url-fetch, youtube-transcript) reads "Couldn't fetch <title>." with
 * the provider's reason behind it, any other failure keeps its raw reason, and
 * a skipped row reads as unsupported. Derived, never stored — the fixture is
 * one document plus extraction rows.
 */

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { await handle?.client.end(); });

suite("listSources failure labels (Neon)", () => {
  it("prefixes a fetch-class failure with Couldn't fetch and keeps other reasons raw", async () => {
    if (!handle) return;
    const seed = await seedWorkspace(handle.db, `readiness-${Date.now()}`);
    const auth = ownerAuth(seed.userId, seed.workspaceId);

    const [fetched] = await handle.db
      .insert(documents)
      .values({ workspaceId: seed.workspaceId, title: "Housing memo", sourceUrl: "https://example.com/memo", createdBy: seed.userId, updatedBy: seed.userId })
      .returning({ id: documents.id });
    await handle.db.insert(documentExtractions).values({
      workspaceId: seed.workspaceId, documentId: fetched!.id, contentHash: "unfetched:a",
      status: "failed", extractor: "url-fetch", error: "The site answered with status 500.",
    });

    const [plain] = await handle.db
      .insert(documents)
      .values({ workspaceId: seed.workspaceId, title: "Broken doc", createdBy: seed.userId, updatedBy: seed.userId })
      .returning({ id: documents.id });
    await handle.db.insert(documentExtractions).values({
      workspaceId: seed.workspaceId, documentId: plain!.id, contentHash: "h:b",
      status: "failed", extractor: "docling@1", error: "The PDF could not be parsed.",
    });

    const [skipped] = await handle.db
      .insert(documents)
      .values({ workspaceId: seed.workspaceId, title: "Unknown type", createdBy: seed.userId, updatedBy: seed.userId })
      .returning({ id: documents.id });
    await handle.db.insert(documentExtractions).values({
      workspaceId: seed.workspaceId, documentId: skipped!.id, contentHash: "h:c",
      status: "skipped", extractor: "docling@1", error: null,
    });

    const rows = await listSources(auth, {});
    const byTitle = new Map(rows.map((r) => [r.title, r]));

    // Fetch-class: the label leads, the provider's reason rides behind it.
    const fetchedRow = byTitle.get("Housing memo")!;
    expect(fetchedRow.readiness).toBe("failed");
    expect(fetchedRow.detail).toBe("Couldn't fetch Housing memo. The site answered with status 500.");

    // A non-fetch failure keeps the raw reason; no label rewrite.
    const plainRow = byTitle.get("Broken doc")!;
    expect(plainRow.readiness).toBe("failed");
    expect(plainRow.detail).toBe("The PDF could not be parsed.");

    // No reader accepts it: unsupported, with the standing reason.
    const skippedRow = byTitle.get("Unknown type")!;
    expect(skippedRow.readiness).toBe("unsupported");
    expect(skippedRow.detail).toBe("No reader accepts this source type.");
  });
});
