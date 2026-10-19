import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * A02 inbox invariants: captures keep their original text through
 * conversion, clarify-to-task commits the task and the lineage edge in one
 * transaction, a second conversion is a conflict rather than a second task,
 * and archive/restore are version-checked.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/capture/commands");
let queries: typeof import("@/domains/capture/queries");
let workQueries: typeof import("@/domains/work/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/capture/commands");
  queries = await import("@/domains/capture/queries");
  workQueries = await import("@/domains/work/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

async function auditCount(auth: { workspaceId: string }, subjectId: string) {
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, auth.workspaceId));
  return rows.filter((row) => row.subjectId === subjectId).length;
}

suite("capture inbox", () => {
  it("captures text and detects urls, with an audit row", async () => {
    const auth = await seed("capture-create");
    const note = await commands.createCapture(auth, { text: "Call the accountant about Q3" });
    expect(note.kind).toBe("text");
    expect(note.processingState).toBe("unprocessed");

    const link = await commands.createCapture(auth, { text: "https://example.com/spec" });
    expect(link.kind).toBe("url");
    expect(link.url).toBe("https://example.com/spec");
    await expect(commands.createCapture(auth, { text: "https://example.com/spec" })).rejects.toMatchObject({
      code: "conflict",
    });

    expect(await queries.countToClarify(auth)).toBe(2);
    expect(await auditCount(auth, note.id)).toBe(1);
  });

  it("converts to a canonical task in one transaction and refuses a second conversion", async () => {
    const auth = await seed("capture-convert");
    const capture = await commands.createCapture(auth, {
      text: "Renew the domains before they lapse - the registrar mails the old address",
    });
    const { task, capture: converted } = await commands.convertCaptureToTask(auth, {
      captureId: capture.id,
      expectedVersion: capture.version,
    });
    expect(converted.processingState).toBe("converted");
    expect(converted.convertedType).toBe("task");
    expect(converted.convertedId).toBe(task.id);
    // The original text survives conversion untouched.
    expect(converted.text).toBe(capture.text);

    const detail = await workQueries.getTaskDetail(auth, task.id);
    expect(detail?.task.title).toContain("Renew the domains");

    await expect(
      commands.convertCaptureToTask(auth, { captureId: capture.id, expectedVersion: converted.version }),
    ).rejects.toMatchObject({ code: "conflict" });
    // A wrong version on a capture that is still open is the stale-write path.
    const fresh = await commands.createCapture(auth, { text: "Still open" });
    await expect(
      commands.convertCaptureToTask(auth, { captureId: fresh.id, expectedVersion: fresh.version + 9 }),
    ).rejects.toMatchObject({ code: "stale_write" });
    expect(await auditCount(auth, capture.id)).toBe(2);
  });

  it("archives and restores, version-checked, and never un-converts", async () => {
    const auth = await seed("capture-archive");
    const capture = await commands.createCapture(auth, { text: "Maybe read this later" });
    const archived = await commands.setCaptureState(auth, {
      captureId: capture.id,
      expectedVersion: capture.version,
      state: "discarded",
    });
    expect(archived.processingState).toBe("discarded");
    expect(await queries.countToClarify(auth)).toBe(0);

    await expect(
      commands.setCaptureState(auth, { captureId: capture.id, expectedVersion: capture.version, state: "unprocessed" }),
    ).rejects.toMatchObject({ code: "stale_write" });

    const restored = await commands.setCaptureState(auth, {
      captureId: capture.id,
      expectedVersion: archived.version,
      state: "unprocessed",
    });
    expect(restored.processingState).toBe("unprocessed");
    expect(await queries.countToClarify(auth)).toBe(1);

    // A converted capture cannot be archived or restored by hand.
    const converted = await commands.createCapture(auth, { text: "Turn me into work" });
    await commands.convertCaptureToTask(auth, { captureId: converted.id, expectedVersion: converted.version });
    const after = (await queries.listCaptures(auth, "converted"))[0];
    await expect(
      commands.setCaptureState(auth, { captureId: after.id, expectedVersion: after.version, state: "discarded" }),
    ).rejects.toMatchObject({ code: "stale_write" });
  });
});
