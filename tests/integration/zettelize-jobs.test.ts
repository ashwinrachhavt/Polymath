import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditEvents, outboxEvents } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";
import { generationJobs } from "@/domains/jobs/schema";
import { artifactVersions, artifacts, documents } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Zettelize as generation jobs (real Postgres). The invariants this suite
 * exists to prove:
 *
 *   - a request is one job per eligible source (capture or document), each
 *     with its run event in the same commit; ineligible sources are counted
 *     as skipped, a replayed key creates nothing new, and a request is
 *     bounded at MAX_ZETTELIZE_SOURCES;
 *   - the runner files a capture as a library document and creates cards
 *     directly; a candidate whose quote is not verbatim is dropped, and a
 *     second pass over the same document creates nothing new;
 *   - a source that became ineligible before the run fails with authored copy;
 *   - the cards are Ideas, never Notes: the Notes list reads leave them out.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
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

import { requestZettelJobs, zettelizeSource } from "@/domains/capture/zettel-generation";
import { MAX_ZETTELIZE_SOURCES, ZETTEL_JOB_KIND } from "@/domains/capture/zettel-job-names";
import { GENERATION_JOB_TOPIC } from "@/domains/jobs/commands";
import { GenerationJobFailure } from "@/domains/jobs/state";
import { LINKABLE_KINDS, createNote, listNotes, pageNotes } from "@/domains/knowledge/notes";
import type { ZettelExtractor } from "@/integrations/zettels/extractor";

const BODY =
  "Atomic notes compound. A zettel carries one idea, verbatim evidence, and links to its neighbours. Writing them daily turns reading into thinking.";
const Q1 = "A zettel carries one idea, verbatim evidence";
const Q2 = "Writing them daily turns reading into thinking.";

// Generation keys unset for the whole suite: the pass under test must be the
// only consumer, so the extraction pipeline's own creation run cannot race
// the assertions.
beforeAll(() => {
  holder.db = handle?.db;
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("DOCLING_SERVE_URL", "");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});

const extractor = (cands: Array<{ title: string; content: string; quote?: string }>): ZettelExtractor => ({
  name: "fake@1",
  extract: async () => cands,
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(
    holder.db!,
    `zjob-${slug}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
  );
  return ownerAuth(userId, workspaceId);
}

async function addCapture(
  auth: { workspaceId: string; userId: string },
  row: {
    text?: string | null;
    kind?: "text" | "file" | "url";
    state?: "unprocessed" | "converted" | "discarded";
    convertedType?: string;
    convertedId?: string;
  },
) {
  const [created] = await holder
    .db!.insert(captures)
    .values({
      workspaceId: auth.workspaceId,
      kind: row.kind ?? "text",
      captureMode: row.kind === "file" ? "blob" : "authored",
      rawPayload: row.text ? { text: row.text } : {},
      text: row.text ?? null,
      processingState: row.state ?? "unprocessed",
      convertedType: row.convertedType ?? null,
      convertedId: row.convertedId ?? null,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  return created;
}

async function jobRows(workspaceId: string) {
  return holder.db!.select().from(generationJobs).where(eq(generationJobs.workspaceId, workspaceId));
}

suite("zettelize requests", () => {
  it("submits one job per eligible source with its run event, and counts the rest as skipped", async () => {
    const auth = await seed("request");
    const withText = await addCapture(auth, { text: BODY });
    const blank = await addCapture(auth, { text: "   " });
    const file = await addCapture(auth, { text: null, kind: "file" });
    const filed = await addCapture(auth, {
      text: BODY,
      state: "converted",
      convertedType: "task",
      convertedId: crypto.randomUUID(),
    });
    const [doc] = await holder
      .db!.insert(documents)
      .values({ workspaceId: auth.workspaceId, title: "A library document", createdBy: auth.userId })
      .returning();

    const outcome = await requestZettelJobs(auth, {
      idempotencyKey: crypto.randomUUID(),
      sources: [
        { kind: "capture", id: withText.id },
        { kind: "capture", id: blank.id },
        { kind: "capture", id: file.id },
        { kind: "capture", id: filed.id },
        { kind: "document", id: doc.id },
        { kind: "document", id: crypto.randomUUID() },
      ],
    });
    expect(outcome.skipped).toBe(4);
    expect(outcome.jobs.map((job) => job.subject)).toEqual([`capture:${withText.id}`, `document:${doc.id}`]);
    expect(outcome.created).toHaveLength(2);

    const rows = await jobRows(auth.workspaceId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === ZETTEL_JOB_KIND && row.status === "queued")).toBe(true);

    const events = await holder
      .db!.select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, auth.workspaceId), eq(outboxEvents.topic, GENERATION_JOB_TOPIC)));
    expect(events.map((e) => (e.payload as { jobId: string }).jobId).sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it("replays the same key without a second job", async () => {
    const auth = await seed("replay");
    const capture = await addCapture(auth, { text: BODY });
    const key = crypto.randomUUID();
    const sources = [{ kind: "capture" as const, id: capture.id }];

    const first = await requestZettelJobs(auth, { idempotencyKey: key, sources });
    const second = await requestZettelJobs(auth, { idempotencyKey: key, sources });
    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.jobs[0]?.id).toBe(first.jobs[0]?.id);
    expect(await jobRows(auth.workspaceId)).toHaveLength(1);
  });

  it("is bounded at the learning-source limit", async () => {
    const auth = await seed("bound");
    const many = await Promise.all(
      Array.from({ length: MAX_ZETTELIZE_SOURCES + 3 }, (_, i) => addCapture(auth, { text: `${BODY} ${i}` })),
    );
    const outcome = await requestZettelJobs(auth, {
      idempotencyKey: crypto.randomUUID(),
      sources: many.map((c) => ({ kind: "capture" as const, id: c.id })),
    });
    expect(outcome.jobs).toHaveLength(MAX_ZETTELIZE_SOURCES);
    expect(outcome.skipped).toBe(3);
  });
});

suite("zettelize runs", () => {
  it("files the capture, creates the cards directly, and drops a quote that is not in it", async () => {
    const auth = await seed("create");
    const capture = await addCapture(auth, { text: BODY });

    const pass = await zettelizeSource(
      auth,
      { kind: "capture", id: capture.id },
      {
        extractor: extractor([
          { title: "One idea per zettel", content: "A zettel holds exactly one idea.", quote: Q1 },
          { title: "Invented", content: "Never written.", quote: "this passage was never in the capture" },
          { title: "Daily writing", content: "Writing daily turns reading into thinking.", quote: Q2 },
        ]),
      },
    );
    expect(pass.created).toHaveLength(2);

    const [row] = await holder.db!.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.processingState).toBe("converted");
    expect(row.convertedType).toBe("document");
    expect(row.convertedId).toBe(pass.documentId);

    const cards = await holder
      .db!.select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "zettel")));
    expect(cards).toHaveLength(2);
    expect(cards.every((c) => c.status === "generated" && c.currentVersionId !== null)).toBe(true);
    const versions = await holder
      .db!.select()
      .from(artifactVersions)
      .where(
        inArray(
          artifactVersions.artifactId,
          cards.map((c) => c.id),
        ),
      );
    expect(versions.filter((v) => v.plainText?.includes("A zettel holds exactly one idea.")).length).toBe(1);

    const audits = await holder
      .db!.select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "capture.zettels_created")));
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ documentId: pass.documentId, skippedDuplicates: 0 });
  });

  it("keeps the cards out of every Notes list while links still reach them", async () => {
    const auth = await seed("notes");
    const capture = await addCapture(auth, { text: BODY });
    await zettelizeSource(
      auth,
      { kind: "capture", id: capture.id },
      { extractor: extractor([{ title: "One idea per zettel", content: "One idea.", quote: Q1 }]) },
    );
    await createNote(auth, { title: "My own note", plainText: "Written by me.", idempotencyKey: crypto.randomUUID() });

    expect((await listNotes(auth)).map((n) => n.title)).toEqual(["My own note"]);
    const rail = await pageNotes(auth, { limit: 50, offset: 0 });
    expect(rail.items.map((n) => n.title)).toEqual(["My own note"]);
    expect(rail.total).toBe(1);
    // The link picker asks for both kinds on purpose: a [[link]] may point at an idea.
    const linkable = await listNotes(auth, 50, LINKABLE_KINDS);
    expect(linkable.map((n) => n.kind).sort()).toEqual(["note", "zettel"]);
  });

  it("creates nothing new on a second pass over the same document", async () => {
    const auth = await seed("second-pass");
    const capture = await addCapture(auth, { text: BODY });
    const deps = { extractor: extractor([{ title: "One idea", content: "One idea.", quote: Q1 }]) };

    const first = await zettelizeSource(auth, { kind: "capture", id: capture.id }, deps);
    expect(first.created).toHaveLength(1);
    // The capture is filed now, so the second pass reads its document.
    const second = await zettelizeSource(auth, { kind: "document", id: first.documentId }, deps);
    expect(second.created).toHaveLength(0);
  });

  it("fails with authored copy when the capture was archived before the run", async () => {
    const auth = await seed("archived");
    const archived = await addCapture(auth, { text: BODY, state: "discarded" });
    await expect(zettelizeSource(auth, { kind: "capture", id: archived.id })).rejects.toBeInstanceOf(
      GenerationJobFailure,
    );
  });
});
