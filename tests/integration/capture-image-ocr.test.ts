import { eq } from "drizzle-orm";
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditEvents, outboxEvents } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";
import { workspaces } from "@/domains/identity/schema";
import { validateFile } from "@/lib/file-validation";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import type { AuthContext } from "@/domains/identity/resolve";

/*
 * The image rung beside the voice rung (ASH-298's pattern): an image capture
 * is promised a reading when the deployment opts in (OCR_PROVIDER=openrouter),
 * the reading lands as the capture's text, and the SAME enrichment ladder
 * classifies the words - no parallel pipeline. Verified here: the enqueue gate
 * (images yes, unreadable-content files no, quarantined no), the reading
 * landing with a system audit row, idempotence against a second run, and the
 * honest states - not-configured, provider failure, misconfigured model - that
 * name a reason on the row instead of looping or lying.
 */

// In-memory object store: the upload and the vision read both hit it.
const store = new Map<string, Uint8Array>();
vi.mock("@/integrations/object-store/vercel-blob", () => ({
  putBlob: vi.fn(async (input: { bytes: Uint8Array; filename: string; workspaceId: string }) => {
    const storageKey = `https://blob.test/${input.workspaceId}/${crypto.randomUUID()}/${input.filename}`;
    store.set(storageKey, input.bytes);
    return { storageKey, contentHash: "test-hash", sizeBytes: input.bytes.byteLength };
  }),
  readBlob: vi.fn(async (storageKey: string) => {
    const bytes = store.get(storageKey);
    if (!bytes) throw new Error("Stored blob is unavailable");
    return bytes;
  }),
  deleteBlob: vi.fn(async (storageKey: string) => {
    store.delete(storageKey);
  }),
}));

// Real magic numbers, so validateFile's sniff - not the client's claim - picks the type.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x02, 0x03]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const TEXT = new Uint8Array([0x77, 0x6f, 0x72, 0x6b, 0x73, 0x68, 0x6f, 0x70, 0x0a]); // "workshop\n"
const UNIDENTIFIABLE = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);

// Short on purpose: under the LLM threshold, so the deterministic tiers own
// the outcome and no generation key decides what this suite proves.
const READING = "Standup notes: the shipping date moved to Friday.";

const read = vi.fn(async () => ({
  ok: true as const,
  text: READING,
  spans: [{ page: 1, start: 0, end: READING.length }],
  pageCount: 1,
  extractor: "fixture:openrouter-vision",
}));

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/capture/commands");
let handler: typeof import("@/domains/capture/enrichment-handler");
let auth: AuthContext;
let workspaceId: string;

beforeAll(async () => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/capture/commands");
  handler = await import("@/domains/capture/enrichment-handler");
  const seeded = await seedWorkspace(db, `capture-image-ocr-${Date.now()}`);
  workspaceId = seeded.workspaceId;
  auth = ownerAuth(seeded.userId, workspaceId);
});

afterEach(() => {
  // Env-mutating tests restore the token themselves; keep the upload gate stable regardless.
  vi.unstubAllEnvs();
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
  read.mockClear();
});

afterAll(async () => {
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await handle?.client.end();
});

async function fileCapture(bytes: Uint8Array, filename: string) {
  const verdict = validateFile(bytes, filename);
  if (!verdict.ok) throw new Error(`test fixture must sniff: ${filename}`);
  return commands.createFileCapture(auth, { bytes, filename, verdict });
}

async function imageCapture(bytes = PNG, filename = "screenshot.png") {
  return fileCapture(bytes, filename);
}

async function runEnrichment(captureId: string, deps: Parameters<typeof handler.runCaptureEnrichment>[1] = {}) {
  const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, handler.CAPTURE_ENRICHMENT_TOPIC));
  const event = events.find((e) => (e.payload as { captureId: string }).captureId === captureId);
  if (!event) throw new Error("no enrichment event enqueued for the capture");
  await handler.runCaptureEnrichment(
    { id: event.id, workspaceId, topic: event.topic, payload: event.payload } as Parameters<
      typeof handler.runCaptureEnrichment
    >[0],
    deps,
  );
}

async function getCapture(id: string) {
  const [row] = await db.select().from(captures).where(eq(captures.id, id)).limit(1);
  return row;
}

async function enrichmentEventFor(captureId: string) {
  const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, handler.CAPTURE_ENRICHMENT_TOPIC));
  return events.find((e) => (e.payload as { captureId: string }).captureId === captureId);
}

const fixtureReader = { extract: read };

suite("capture image ocr rung", () => {
  it("an image upload is a file capture with enrichment enqueued", async () => {
    const { captureId, quarantined } = await imageCapture();
    expect(quarantined).toBe(false);
    const row = await getCapture(captureId);
    expect(row.kind).toBe("file");
    expect(row.captureMode).toBe("blob");
    expect(row.text).toBeNull();
    expect(row.blobId).not.toBeNull();

    expect(await enrichmentEventFor(captureId)).toBeDefined();
  });

  it("every admitted image mime enqueues (jpeg, webp)", async () => {
    const jpeg = await imageCapture(JPEG, "photo.jpeg");
    expect(await enrichmentEventFor(jpeg.captureId)).toBeDefined();
    const webp = await imageCapture(WEBP, "shot.webp");
    expect(await enrichmentEventFor(webp.captureId)).toBeDefined();
  });

  it("files without readable contents do not enqueue enrichment", async () => {
    const text = await fileCapture(TEXT, "notes.txt");
    expect(await enrichmentEventFor(text.captureId)).toBeUndefined();
    const pdf = await fileCapture(PDF, "scan.pdf");
    expect(await enrichmentEventFor(pdf.captureId)).toBeUndefined();
  });

  it("a quarantined upload is stored as-is and does not enqueue", async () => {
    const verdict = validateFile(UNIDENTIFIABLE, "mystery.bin");
    if (verdict.ok) throw new Error("unidentifiable bytes must quarantine");
    const { captureId, quarantined } = await commands.createFileCapture(auth, {
      bytes: UNIDENTIFIABLE,
      filename: "mystery.bin",
      verdict,
    });
    expect(quarantined).toBe(true);
    expect(await enrichmentEventFor(captureId)).toBeUndefined();
  });

  it("audio still enqueues enrichment", async () => {
    const voice = await fileCapture(WEBM, "voice-note.webm");
    const row = await getCapture(voice.captureId);
    expect(row.kind).toBe("voice");
    expect(await enrichmentEventFor(voice.captureId)).toBeDefined();
  });

  it("the reading lands as the capture's text and the same ladder classifies the words", async () => {
    const { captureId } = await imageCapture();
    await runEnrichment(captureId, { ocr: fixtureReader });

    expect(read).toHaveBeenCalledOnce();
    // The reader saw the original bytes under the sniffed type - not a re-render.
    expect(read).toHaveBeenCalledWith({ bytes: PNG, filename: "screenshot.png", mimeType: "image/png" });

    const row = await getCapture(captureId);
    expect(row.text).toBe(READING);
    // The ladder classified the reading like any other text capture.
    expect(row.cleanText).toBe(READING);
    expect(row.structure).toBe("prose");
    expect(row.processingState).toBe("enriched");
    expect(row.failureReason).toBeNull();

    // System audit: the reading's provenance is on the record.
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.subjectId, captureId));
    expect(audits.some((a) => a.action === "capture.extracted" && a.actorKind === "system")).toBe(true);
  });

  it("a second run does not read the image again", async () => {
    const { captureId } = await imageCapture();
    await runEnrichment(captureId, { ocr: fixtureReader });
    await runEnrichment(captureId, { ocr: fixtureReader });

    expect(read).toHaveBeenCalledOnce();
    const row = await getCapture(captureId);
    expect(row.text).toBe(READING);
    expect(row.processingState).toBe("enriched");
  });

  it("no reader configured: honest failed state, image kept, no error thrown", async () => {
    vi.stubEnv("OCR_PROVIDER", "");
    const { captureId } = await imageCapture();
    // No injected reader and no OCR_PROVIDER in env: the seam answers
    // unconfigured and the capture says so.
    await runEnrichment(captureId);

    const row = await getCapture(captureId);
    expect(row.processingState).toBe("failed");
    expect(row.failureReason).toContain("Image reading is not configured");
    expect(row.failureReason).toContain("OCR_PROVIDER");
    expect(row.text).toBeNull();
    expect(row.blobId).not.toBeNull();
  });

  it("a reader failure lands on the row with the provider's reason and completes the event", async () => {
    const { captureId } = await imageCapture();
    await runEnrichment(captureId, {
      ocr: {
        extract: vi.fn(async () => ({
          ok: false as const,
          error: "openrouter vision could not read page 1: HTTP 503",
          extractor: "fixture:openrouter-vision",
        })),
      },
    });

    const row = await getCapture(captureId);
    expect(row.processingState).toBe("failed");
    expect(row.failureReason).toContain("HTTP 503");
    expect(row.text).toBeNull();
    expect(row.blobId).not.toBeNull();
  });

  it("misconfigured OCR_MODEL resolves to a named failure, not a redelivery loop", async () => {
    vi.stubEnv("OCR_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("OCR_MODEL", "unverified/model-not-allowed");
    const { captureId } = await imageCapture();
    await runEnrichment(captureId);

    const row = await getCapture(captureId);
    expect(row.processingState).toBe("failed");
    expect(row.failureReason).toContain("Image reading is misconfigured");
    expect(row.failureReason).toContain("not one of the rate-verified choices");
  });
});
