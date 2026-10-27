import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaces } from "@/domains/identity/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Rolling deploy: migration 0258 is applied BEFORE the new build ships, so the
 * previous build keeps inserting captures with no capture_mode and no
 * content_hash until it is replaced (and again after a rollback). These raw
 * inserts are that old writer. The 0258 trigger must give each row the mode and
 * hash the new code would have, and the finer identity rules must still apply.
 *
 * Value: protects=an old build never fails on NOT NULL/CHECK during the apply-to-deploy
 * window or after rollback; fails_when=0258 stops filling mode/hash for a writer that omits them.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let workspaceId: string;

beforeAll(async () => {
  if (!handle) return;
  workspaceId = (await seedWorkspace(handle.db, `capture-old-writer-${Date.now()}`)).workspaceId;
});
afterAll(async () => {
  if (!handle) return;
  await handle.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await handle.client.end();
});

async function oldInsert(kind: string, text: string | null, url: string | null) {
  const c = handle!.client;
  await c`insert into captures (workspace_id, kind, source, raw_payload, text, url)
          values (${workspaceId}, ${kind}, 'quick_capture', '{}'::jsonb, ${text}, ${url})`;
  const [row] = await c`select capture_mode, content_hash from captures
                         where workspace_id = ${workspaceId} and kind = ${kind} order by created_at desc, id desc limit 1`;
  return row as { capture_mode: string; content_hash: string | null };
}

suite("captures written by the pre-0258 build", () => {
  it("fills mode and hash from the row's shape, matching inferCaptureMode", async () => {
    expect(await oldInsert("url", null, "https://old.example/ref")).toMatchObject({
      capture_mode: "url-reference",
      content_hash: null,
    });
    const page = await oldInsert("text", "grabbed words", "https://old.example/page");
    expect(page.capture_mode).toBe("page");
    expect(page.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await oldInsert("text", "just a note", null)).toMatchObject({
      capture_mode: "authored",
      content_hash: null,
    });
    expect(await oldInsert("file", null, null)).toMatchObject({ capture_mode: "blob", content_hash: null });
  });

  it("still dedupes: same address twice and the same page text twice are 23505, a new reading is not", async () => {
    await expect(oldInsert("url", null, "https://old.example/ref")).rejects.toMatchObject({ code: "23505" });
    await expect(oldInsert("text", "grabbed words", "https://old.example/page")).rejects.toMatchObject({
      code: "23505",
    });
    await expect(oldInsert("text", "a different reading", "https://old.example/page")).resolves.toMatchObject({
      capture_mode: "page",
    });
  });
});
