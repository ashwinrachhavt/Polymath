import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditEvents, outboxEvents } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";
import { artifactVersions, artifacts, documents, zettelProposals } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * "Generate zettels" from the inbox (real Postgres): the request half takes a
 * receipt and queues one outbox row per open capture that carries text; the
 * work half files each capture as a library document and creates zettel cards
 * from it. The invariants this suite exists to prove:
 *
 *   - one click is one queue entry per capture, and a replay queues nothing;
 *   - captures with no text (a file, an unfetched link) and captured rows that
 *     already became something are not sources;
 *   - the pass creates cards directly - the triggering click is the
 *     permission, and no proposal row is written - and a candidate whose
 *     quote is not verbatim is dropped;
 *   - a second pass over the same document creates nothing new (the span is
 *     already a card) and embeds the new cards best-effort after the commit.
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

import {
  ZETTEL_GENERATION_TOPIC,
  countZettelSourceCaptures,
  listZettelSourceCaptures,
  requestZettelGeneration,
  runZettelGenerationRequested,
} from "@/domains/capture/zettel-generation";
import type { ClaimedOutboxEvent } from "@/domains/audit/outbox";
import type { ZettelExtractor } from "@/integrations/zettels/extractor";

const BODY =
  "Atomic notes compound. A zettel carries one idea, verbatim evidence, and links to its neighbours. Writing them daily turns reading into thinking.";
const Q1 = "A zettel carries one idea, verbatim evidence";
const Q2 = "Writing them daily turns reading into thinking.";

// Generation keys unset for the whole suite: the pass under test must be the
// only consumer, so the extraction pipeline's own creation run cannot race
// the assertions the way it did in the zettel-view suites.
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

const ownerAuthFor = (workspaceId: string) => async () => ownerAuth(workspaceOf.get(workspaceId)!, workspaceId);
const workspaceOf = new Map<string, string>();

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(
    holder.db!,
    `zgen-${slug}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
  );
  workspaceOf.set(workspaceId, userId);
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

function event(auth: { workspaceId: string }, captureId: string): ClaimedOutboxEvent {
  return {
    id: crypto.randomUUID(),
    workspaceId: auth.workspaceId,
    topic: ZETTEL_GENERATION_TOPIC,
    payload: { captureId },
    attempts: 0,
    leaseToken: crypto.randomUUID(),
  };
}

suite("zettel generation from the inbox", () => {
  it("queues one outbox row per capture with text and an audit row in the same commit", async () => {
    const auth = await seed("queue");
    const withText = await addCapture(auth, { text: BODY });
    await addCapture(auth, { text: "   " });
    await addCapture(auth, { text: null, kind: "file" });
    const alreadyFiled = await addCapture(auth, {
      text: BODY,
      state: "converted",
      convertedType: "task",
      convertedId: crypto.randomUUID(),
    });

    expect(await countZettelSourceCaptures(auth)).toBe(1);
    const queued = await requestZettelGeneration(auth, { idempotencyKey: crypto.randomUUID() });
    expect(queued.queued).toBe(1);
    expect(queued.captureIds).toEqual([withText.id]);

    const rows = await holder
      .db!.select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, auth.workspaceId), eq(outboxEvents.topic, ZETTEL_GENERATION_TOPIC)));
    expect(rows.map((r) => (r.payload as { captureId: string }).captureId)).toEqual([withText.id]);

    const audits = await holder
      .db!.select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "capture.zettels_requested")));
    expect(audits.map((a) => a.subjectId)).toEqual([withText.id]);

    // A converted capture keeps the home the owner chose.
    const again = await requestZettelGeneration(auth, { idempotencyKey: crypto.randomUUID() });
    expect(again.captureIds).not.toContain(alreadyFiled.id);
  });

  it("replays the same key without queueing a second pass", async () => {
    const auth = await seed("replay");
    await addCapture(auth, { text: BODY });
    const key = crypto.randomUUID();

    const first = await requestZettelGeneration(auth, { idempotencyKey: key });
    const second = await requestZettelGeneration(auth, { idempotencyKey: key });
    expect(first.queued).toBe(1);
    expect(second).toMatchObject({ queued: 1, replayed: true });

    const rows = await holder
      .db!.select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, auth.workspaceId), eq(outboxEvents.topic, ZETTEL_GENERATION_TOPIC)));
    expect(rows).toHaveLength(1);
  });

  it("files the capture, creates the cards directly, and drops a quote that is not in it", async () => {
    const auth = await seed("create");
    const capture = await addCapture(auth, { text: BODY });

    const result = await runZettelGenerationRequested(event(auth, capture.id), {
      auth: ownerAuthFor(auth.workspaceId),
      extractor: extractor([
        { title: "One idea per zettel", content: "A zettel holds exactly one idea.", quote: Q1 },
        { title: "Invented", content: "Never written.", quote: "this passage was never in the capture" },
        { title: "Daily writing", content: "Writing daily turns reading into thinking.", quote: Q2 },
      ]),
    });
    expect(result.created).toBe(2);

    const [row] = await holder.db!.select().from(captures).where(eq(captures.id, capture.id));
    expect(row.processingState).toBe("converted");
    expect(row.convertedType).toBe("document");

    const [doc] = await holder.db!.select().from(documents).where(eq(documents.id, row.convertedId!));
    expect(doc.workspaceId).toBe(auth.workspaceId);

    // The triggering click is the permission: the cards exist and no proposal
    // row waits for a second decision anywhere in this workspace.
    const cards = await holder
      .db!.select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "zettel")));
    expect(cards).toHaveLength(2);
    expect(cards.every((c) => c.status === "reviewed" && c.currentVersionId !== null)).toBe(true);
    expect(
      await holder.db!.select().from(zettelProposals).where(eq(zettelProposals.workspaceId, auth.workspaceId)),
    ).toHaveLength(0);

    const versions = await holder
      .db!.select()
      .from(artifactVersions)
      .where(
        inArray(
          artifactVersions.artifactId,
          cards.map((c) => c.id),
        ),
      );
    expect(versions).toHaveLength(2);
    expect(versions.filter((v) => v.plainText?.includes("A zettel holds exactly one idea.")).length).toBe(1);

    const audits = await holder
      .db!.select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "capture.zettels_created")));
    expect(audits).toHaveLength(1);
    expect(audits[0].subjectId).toBe(capture.id);
    expect(audits[0].metadata).toMatchObject({ documentId: doc.id, skippedDuplicates: 0 });
  });

  it("creates nothing new on a second pass over the same document", async () => {
    const auth = await seed("second-pass");
    const capture = await addCapture(auth, { text: BODY });
    const deps = {
      auth: ownerAuthFor(auth.workspaceId),
      extractor: extractor([{ title: "One idea", content: "One idea.", quote: Q1 }]),
    };

    expect((await runZettelGenerationRequested(event(auth, capture.id), deps)).created).toBe(1);
    expect((await runZettelGenerationRequested(event(auth, capture.id), deps)).created).toBe(0);

    const cards = await holder
      .db!.select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "zettel")));
    expect(cards).toHaveLength(1);
  });

  it("skips a capture that has no text and one that was archived", async () => {
    const auth = await seed("skip");
    const file = await addCapture(auth, { text: null, kind: "file" });
    const archived = await addCapture(auth, { text: BODY, state: "discarded" });
    const deps = {
      auth: ownerAuthFor(auth.workspaceId),
      extractor: extractor([{ title: "One idea", content: "One idea.", quote: Q1 }]),
    };

    expect((await runZettelGenerationRequested(event(auth, file.id), deps)).created).toBe(0);
    expect((await runZettelGenerationRequested(event(auth, archived.id), deps)).created).toBe(0);

    const sources = await listZettelSourceCaptures(auth, { ids: [file.id, archived.id] });
    expect(sources).toEqual([]);
  });

  it("narrows a request to the captures it was given", async () => {
    const auth = await seed("narrow");
    const first = await addCapture(auth, { text: BODY });
    await addCapture(auth, { text: `${BODY} A second capture.` });

    const queued = await requestZettelGeneration(auth, { idempotencyKey: crypto.randomUUID(), captureIds: [first.id] });
    expect(queued.captureIds).toEqual([first.id]);
    expect(queued.skipped).toBe(0);
  });

  it("queues exactly one capture when the request names one (the detail verb's call)", async () => {
    const auth = await seed("single");
    const capture = await addCapture(auth, { text: BODY });
    await addCapture(auth, { text: `${BODY} Another open capture.` });

    const queued = await requestZettelGeneration(auth, {
      idempotencyKey: crypto.randomUUID(),
      captureIds: [capture.id],
    });
    expect(queued.queued).toBe(1);
    expect(queued.captureIds).toEqual([capture.id]);
    expect(queued.skipped).toBe(0);

    // Only the named capture enters the queue, even though another open
    // capture carries text: the verb acts on one capture, never the inbox.
    const rows = await holder
      .db!.select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, auth.workspaceId), eq(outboxEvents.topic, ZETTEL_GENERATION_TOPIC)));
    expect(rows.map((r) => (r.payload as { captureId: string }).captureId)).toEqual([capture.id]);
  });

  it("counts ineligible named captures as skipped instead of queueing them", async () => {
    const auth = await seed("bulk");
    const eligible = await addCapture(auth, { text: BODY });
    const alreadyFiled = await addCapture(auth, {
      text: BODY,
      state: "converted",
      convertedType: "note",
      convertedId: crypto.randomUUID(),
    });
    const archived = await addCapture(auth, { text: BODY, state: "discarded" });
    const unread = await addCapture(auth, { text: null, kind: "file" });

    const queued = await requestZettelGeneration(auth, {
      idempotencyKey: crypto.randomUUID(),
      captureIds: [eligible.id, alreadyFiled.id, archived.id, unread.id],
    });
    expect(queued.queued).toBe(1);
    expect(queued.captureIds).toEqual([eligible.id]);
    expect(queued.skipped).toBe(3);
  });
});
