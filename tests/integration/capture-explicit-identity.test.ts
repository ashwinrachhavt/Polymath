import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaces } from "@/domains/identity/schema";
import { captures } from "@/domains/capture/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Migration 0258 installs a compat trigger that fills capture_mode and
 * content_hash for the OLD build. The current build must never lean on it: it
 * supplies both on every insert. Checking the stored values against the TS
 * functions would pass with the trigger quietly filling an omission, so this
 * test puts a stricter trigger in front of it (BEFORE triggers fire in name
 * order, "aaa_" sorts first) that raises when mode or hash is missing, scoped
 * to this test's workspace so parallel suites are unaffected.
 *
 * Value: protects=the app never depends on the compat trigger to set identity;
 * fails_when=createCapture or the file path inserts a row without capture_mode,
 * or a url-bearing page/selection/authored row without content_hash.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let workspaceId: string;
let auth: ReturnType<typeof ownerAuth>;
let commands: typeof import("@/domains/capture/commands");
const FN = "aaa_assert_explicit_identity_fn";
const TRG = "aaa_assert_explicit_identity_trg";

beforeAll(async () => {
  if (!handle) return;
  commands = await import("@/domains/capture/commands");
  const seeded = await seedWorkspace(handle.db, `capture-explicit-${Date.now()}`);
  workspaceId = seeded.workspaceId;
  auth = ownerAuth(seeded.userId, workspaceId);
  await handle.client.unsafe(`
    CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.workspace_id = TG_ARGV[0]::uuid THEN
        IF NEW.capture_mode IS NULL THEN
          RAISE EXCEPTION 'insert omitted capture_mode';
        END IF;
        IF NEW.url IS NOT NULL AND NEW.capture_mode NOT IN ('url-reference', 'blob') AND NEW.content_hash IS NULL THEN
          RAISE EXCEPTION 'insert omitted content_hash';
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql`);
  await handle.client.unsafe(
    `CREATE TRIGGER ${TRG} BEFORE INSERT ON captures FOR EACH ROW EXECUTE FUNCTION ${FN}('${workspaceId}')`,
  );
});

afterAll(async () => {
  if (!handle) return;
  await handle.client.unsafe(`DROP TRIGGER IF EXISTS ${TRG} ON captures`);
  await handle.client.unsafe(`DROP FUNCTION IF EXISTS ${FN}()`);
  await handle.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await handle.client.end();
});

suite("createCapture supplies identity itself", () => {
  it("authored, selection, page and url-reference inserts all pass the strict trigger", async () => {
    await commands.createCapture(auth, { text: "just a note, no address" });
    await commands.createCapture(auth, { text: "a quoted passage", url: "https://explicit.example/a", mode: "selection" });
    await commands.createCapture(auth, { text: "the whole article text", url: "https://explicit.example/b", mode: "page" });
    await commands.createCapture(auth, { text: "https://explicit.example/c" });
    const rows = await handle!.db.select().from(captures).where(eq(captures.workspaceId, workspaceId));
    expect(rows.map((r) => r.captureMode).sort()).toEqual(["authored", "page", "selection", "url-reference"]);
  });

  it("the strict trigger really rejects an omission (the guard itself works)", async () => {
    await expect(
      handle!.client`insert into captures (workspace_id, kind, source, raw_payload, text, url)
                     values (${workspaceId}, 'text', 'quick_capture', '{}'::jsonb, 'x', 'https://explicit.example/d')`,
    ).rejects.toThrow(/omitted capture_mode/);
  });
});
