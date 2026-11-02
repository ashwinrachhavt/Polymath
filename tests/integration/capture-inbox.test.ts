import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { artifactLinks, artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { captures } from "@/domains/capture/schema";
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

/** A file capture with whatever a reading rung landed on its row (or null). */
async function addBlobCapture(
  auth: { workspaceId: string; userId: string },
  input: { text: string | null; filename: string; mimeType: string },
) {
  const [row] = await db
    .insert(captures)
    .values({
      workspaceId: auth.workspaceId,
      kind: "file",
      captureMode: "blob",
      rawPayload: { filename: input.filename, mimeType: input.mimeType, sizeBytes: 1024, contentHash: "test-hash" },
      text: input.text,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  return row;
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

  it("names the existing capture when a URL duplicates, and never across workspaces", async () => {
    const auth = await seed("capture-duplicate");
    const original = await commands.createCapture(auth, { text: "https://example.com/already-here" });

    const duplicate = await commands.createCapture(auth, { text: "https://example.com/already-here" }).catch((e) => e);
    expect(duplicate).toMatchObject({ code: "conflict", message: "That URL is already in the inbox." });
    // The notice can link straight to the row the person already has.
    expect(duplicate.existingId).toBe(original.id);

    // Same URL in another workspace is its own capture, not a conflict.
    const other = await seed("capture-duplicate-other");
    const theirs = await commands.createCapture(other, { text: "https://example.com/already-here" });
    expect(theirs.id).not.toBe(original.id);

    // And the lookup never leaks the other workspace's row back.
    const again = await commands.createCapture(auth, { text: "https://example.com/already-here" }).catch((e) => e);
    expect(again.existingId).toBe(original.id);
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

  it("converts to a notebook note in one transaction, resolves wiki links, and refuses a second conversion", async () => {
    const auth = await seed("capture-note");
    // An existing note to link to: the capture body names it in [[...]].
    const { createNote } = await import("@/domains/knowledge/notes");
    const target = await createNote(auth, {
      title: "Atomic notes",
      content: { format: "markdown", text: "One idea per note." },
      plainText: "One idea per note.",
      idempotencyKey: crypto.randomUUID(),
    });

    const capture = await commands.createCapture(auth, {
      text: "Zettelkasten is a web of [[Atomic notes]] - links are the thinking",
    });
    const { note, capture: converted } = await commands.convertCaptureToNote(auth, {
      captureId: capture.id,
      expectedVersion: capture.version,
    });
    expect(converted.processingState).toBe("converted");
    expect(converted.convertedType).toBe("note");
    expect(converted.convertedId).toBe(note.id);
    expect(converted.text).toBe(capture.text);

    // The note landed as a normal notebook artifact: kind note, version 1 is
    // the capture text, title from the first line.
    const [artifact] = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, note.id), eq(artifacts.workspaceId, auth.workspaceId)));
    expect(artifact.kind).toBe("note");
    expect(artifact.status).not.toBe("inbox");
    expect(artifact.title).toContain("Zettelkasten");
    const [version] = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.id, artifact.currentVersionId!));
    expect(version.plainText).toBe(capture.text);

    // The wiki link resolved in the same commit.
    const links = await db
      .select()
      .from(artifactLinks)
      .where(and(eq(artifactLinks.workspaceId, auth.workspaceId), eq(artifactLinks.artifactId, note.id)));
    expect(links.map((l) => l.targetId)).toContain(target.id);

    // Converting again is a conflict, never a second note.
    await expect(
      commands.convertCaptureToNote(auth, { captureId: capture.id, expectedVersion: converted.version }),
    ).rejects.toMatchObject({ code: "conflict" });
    const stillOne = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "note")));
    expect(stillOne.filter((a) => a.title.includes("Zettelkasten")).length).toBe(1);

    // A wrong version on an open capture is the stale-write path.
    const fresh = await commands.createCapture(auth, { text: "Another open capture" });
    await expect(
      commands.convertCaptureToNote(auth, { captureId: fresh.id, expectedVersion: fresh.version + 9 }),
    ).rejects.toMatchObject({ code: "stale_write" });
  });

  it("titles conversions from the capture's own title before the first line", async () => {
    const auth = await seed("capture-title-preference");
    // A capture whose stored title is the person's intent: conversion prefers
    // it over the scraped first line of the text.
    const titled = await commands.createCapture(auth, {
      text: "Scraped header noise\nSecond line of the page body",
      title: "Person's intended title",
    });
    const { task } = await commands.convertCaptureToTask(auth, {
      captureId: titled.id,
      expectedVersion: titled.version,
    });
    expect(task.title).toBe("Person's intended title");

    // A title passed at conversion time wins over the stored one.
    const stored = await commands.createCapture(auth, { text: "Stored first line\nBody", title: "Stored title" });
    const { note } = await commands.convertCaptureToNote(auth, {
      captureId: stored.id,
      expectedVersion: stored.version,
      title: "Conversion title",
    });
    const [noteArtifact] = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.id, note.id)));
    expect(noteArtifact.title).toBe("Conversion title");

    // With no title anywhere, the first line still carries.
    const bare = await commands.createCapture(auth, { text: "Bare fallback line\nBody" });
    const { note: bareNote } = await commands.convertCaptureToNote(auth, {
      captureId: bare.id,
      expectedVersion: bare.version,
    });
    const [bareArtifact] = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.id, bareNote.id)));
    expect(bareArtifact.title).toBe("Bare fallback line");
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

  it("edits the working text while rawPayload keeps the original", async () => {
    const auth = await seed("capture-edit");
    const capture = await commands.createCapture(auth, { text: "Call the acccountant about Q3" });
    const raw = JSON.stringify(capture.rawPayload);

    const edited = await commands.updateCaptureText(auth, {
      captureId: capture.id,
      expectedVersion: capture.version,
      text: "  Call the accountant about Q4  ",
    });
    expect(edited.text).toBe("Call the accountant about Q4");
    expect(edited.version).toBe(capture.version + 1);
    // The immutable original is untouched by the edit.
    expect(JSON.stringify(edited.rawPayload)).toBe(raw);

    const [audit] = (await db.select().from(auditEvents).where(eq(auditEvents.subjectId, capture.id))).filter(
      (row) => row.action === "capture.edited",
    );
    expect(audit).toBeTruthy();
    expect(audit.summary).not.toContain("Q4");

    // The same key replays the first result instead of a second write.
    const key = crypto.randomUUID();
    const a = await commands.updateCaptureText(auth, {
      captureId: capture.id,
      expectedVersion: edited.version,
      text: "First",
      idempotencyKey: key,
    });
    const b = await commands.updateCaptureText(auth, {
      captureId: capture.id,
      expectedVersion: edited.version,
      text: "First",
      idempotencyKey: key,
    });
    expect(b.version).toBe(a.version);
    expect((await queries.getCapture(auth, capture.id))?.version).toBe(a.version);
  });

  it("refuses to edit a converted, emptied or stale capture", async () => {
    const auth = await seed("capture-edit-refuse");
    const capture = await commands.createCapture(auth, { text: "Turn me into work" });
    const converted = await commands.convertCaptureToTask(auth, {
      captureId: capture.id,
      expectedVersion: capture.version,
    });
    await expect(
      commands.updateCaptureText(auth, {
        captureId: capture.id,
        expectedVersion: converted.capture.version,
        text: "Rewritten",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const open = await commands.createCapture(auth, { text: "Still open" });
    await expect(
      commands.updateCaptureText(auth, { captureId: open.id, expectedVersion: open.version, text: "   " }),
    ).rejects.toMatchObject({ code: "conflict", message: "A capture cannot be emptied. Archive it instead." });
    await expect(
      commands.updateCaptureText(auth, { captureId: open.id, expectedVersion: open.version + 9, text: "Newer" }),
    ).rejects.toMatchObject({ code: "stale_write" });
    expect((await queries.getCapture(auth, open.id))?.text).toBe("Still open");
  });

  // Two-pane inbox reads (2026-10-20): the detail pane and the tab counts.
  it("getCapture never returns another workspace's capture", async () => {
    const auth = await seed("get-capture");
    const capture = await commands.createCapture(auth, { text: "Mine only" });
    const other = await seedWorkspace(db, `get-capture-other-${Date.now()}`);
    const otherAuth = ownerAuth(other.userId, other.workspaceId);
    expect(await queries.getCapture(auth, capture.id)).toMatchObject({ id: capture.id });
    expect(await queries.getCapture(otherAuth, capture.id)).toBeNull();
  });

  it("countInboxTabs matches the state set searchCaptures uses", async () => {
    const auth = await seed("tab-counts");
    const open = await commands.createCapture(auth, { text: "Open one" });
    await commands.createCapture(auth, { text: "Open two" });
    const converted = await commands.createCapture(auth, { text: "Going to work" });
    await commands.convertCaptureToTask(auth, { captureId: converted.id, expectedVersion: converted.version });
    const discardable = await commands.createCapture(auth, { text: "Going away" });
    await commands.setCaptureState(auth, {
      captureId: discardable.id,
      expectedVersion: discardable.version,
      state: "discarded",
    });
    void open;

    const tabs = await queries.countInboxTabs(auth);
    expect(tabs.unprocessed).toBe(2);
    expect(tabs.converted).toBe(1);
    expect(tabs.discarded).toBe(1);
    expect(tabs.all).toBe(4);
    expect((await queries.searchCaptures(auth, { filter: "converted", limit: 10, offset: 0 })).total).toBe(
      tabs.converted,
    );
    expect((await queries.searchCaptures(auth, { filter: "all", limit: 10, offset: 0 })).total).toBe(tabs.all);
  });

  // File captures search by what their bytes SAID, not just what they are
  // called: the OCR rung lands words on the row and the same text predicate
  // matches them - an unread file stays findable by filename only.
  it("search matches a file capture's extracted reading, not just its filename", async () => {
    const auth = await seed("capture-file-search");
    const read = await addBlobCapture(auth, {
      text: "The receipt lists an absurd shipping fee of forty dollars",
      filename: "receipt-screenshot.png",
      mimeType: "image/png",
    });
    await addBlobCapture(auth, {
      text: null,
      filename: "whiteboard-arch.jpg",
      mimeType: "image/jpeg",
    });

    // A word from inside the screenshot finds the capture; the unread file
    // does not leak in - it carries no text at all.
    const byReading = await queries.searchCaptures(auth, { query: "absurd shipping", limit: 10, offset: 0 });
    expect(byReading.total).toBe(1);
    expect(byReading.items[0]?.id).toBe(read.id);
    // The preview reads from what the capture said, not its filename.
    expect(byReading.items[0]?.preview).toContain("absurd shipping fee");

    // An unread file is still findable by what its filename says.
    const byFilename = await queries.searchCaptures(auth, { query: "whiteboard", limit: 10, offset: 0 });
    expect(byFilename.total).toBe(1);
    expect(byFilename.items[0]?.id).not.toBe(read.id);
  });

  it("the [[ ]] picker matches a reading's words too", async () => {
    const auth = await seed("capture-link-reading");
    const read = await addBlobCapture(auth, {
      text: "Quarterly planning happens on the second Tuesday",
      filename: "planning-photo.png",
      mimeType: "image/png",
    });

    const targets = await queries.searchCapturesForLink(auth, "second Tuesday", 5);
    expect(targets.map((target) => target.id)).toContain(read.id);
  });
});
