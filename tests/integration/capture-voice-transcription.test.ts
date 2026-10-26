import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditEvents, outboxEvents } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";
import { workspaces } from "@/domains/identity/schema";
import { validateFile } from "@/lib/file-validation";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import type { AuthContext } from "@/domains/identity/resolve";

/*
 * ASH-298: a voice capture is promised a transcript, then the SAME enrichment
 * ladder classifies the words - no parallel pipeline. Verified here: the
 * outbox enqueue on audio upload, the transcript landing as the capture's
 * text with a system audit row, the ladder running on the transcript, the
 * honest not-configured state when no provider is selected, and no-speech
 * audio enriching cleanly instead of inventing words.
 */

// In-memory object store: the upload and the transcription read both hit it.
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

const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
// Short on purpose: under the LLM threshold, so the deterministic tiers own
// the outcome and no generation key decides what this suite proves.
const TRANSCRIPT = "Send the Q3 roadmap to Priya by Friday.";

const transcribe = vi.fn(async () => ({ text: TRANSCRIPT }));

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
  const seeded = await seedWorkspace(db, `capture-voice-${Date.now()}`);
  workspaceId = seeded.workspaceId;
  auth = ownerAuth(seeded.userId, workspaceId);
});

afterAll(async () => {
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await handle?.client.end();
});

async function voiceCapture() {
  const verdict = validateFile(WEBM, "voice-note.webm");
  if (!verdict.ok) throw new Error("test audio must sniff");
  return commands.createFileCapture(auth, { bytes: WEBM, filename: "voice-note.webm", verdict });
}

async function runEnrichment(captureId: string, deps: Parameters<typeof handler.runCaptureEnrichment>[1] = {}) {
  const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, handler.CAPTURE_ENRICHMENT_TOPIC));
  const event = events.find((e) => (e.payload as { captureId: string }).captureId === captureId);
  if (!event) throw new Error("no enrichment event enqueued for the voice capture");
  await handler.runCaptureEnrichment(
    { id: event.id, workspaceId, topic: event.topic, payload: event.payload } as Parameters<typeof handler.runCaptureEnrichment>[0],
    deps,
  );
}

async function getCapture(id: string) {
  const [row] = await db.select().from(captures).where(eq(captures.id, id)).limit(1);
  return row;
}

suite("voice capture transcription", () => {
  it("an audio upload is a voice capture with enrichment enqueued", async () => {
    const { captureId, quarantined } = await voiceCapture();
    expect(quarantined).toBe(false);
    const row = await getCapture(captureId);
    expect(row.kind).toBe("voice");
    expect(row.text).toBeNull();

    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, handler.CAPTURE_ENRICHMENT_TOPIC));
    expect(events.some((e) => (e.payload as { captureId: string }).captureId === captureId)).toBe(true);
  });

  it("transcribes into the capture text and the same ladder classifies the words", async () => {
    transcribe.mockClear();
    const { captureId } = await voiceCapture();
    await runEnrichment(captureId, {
      transcriber: { name: "fixture:transcription", registryId: "fixture", transcribe },
    });

    expect(transcribe).toHaveBeenCalledOnce();
    const row = await getCapture(captureId);
    expect(row.text).toBe(TRANSCRIPT);
    // The ladder classified the transcript like any other text capture.
    expect(row.cleanText).toBe(TRANSCRIPT);
    expect(row.structure).toBe("prose");
    expect(row.processingState).toBe("enriched");

    // System audit: the transcript's provenance is on the record.
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.subjectId, captureId));
    expect(audits.some((a) => a.action === "capture.transcribed" && a.actorKind === "system")).toBe(true);
  });

  it("keeps the owner's edited words: a second run does not re-transcribe", async () => {
    transcribe.mockClear();
    const { captureId } = await voiceCapture();
    await runEnrichment(captureId, {
      transcriber: { name: "fixture:transcription", registryId: "fixture", transcribe },
    });
    await commands.updateCaptureText(auth, { captureId, expectedVersion: (await getCapture(captureId)).version, text: "Corrected by the owner." });
    await runEnrichment(captureId, {
      transcriber: { name: "fixture:transcription", registryId: "fixture", transcribe },
    });
    expect(transcribe).toHaveBeenCalledOnce();
    expect((await getCapture(captureId)).text).toBe("Corrected by the owner.");
  });

  it("no provider selected: honest failed state, audio kept, no fake transcript", async () => {
    const { captureId } = await voiceCapture();
    // No injected transcriber and no TRANSCRIPTION_PROVIDER in env: the seam
    // answers unconfigured and the capture says so.
    vi.stubEnv("TRANSCRIPTION_PROVIDER", "");
    await runEnrichment(captureId);

    const row = await getCapture(captureId);
    expect(row.processingState).toBe("failed");
    expect(row.failureReason).toContain("Transcription is not configured");
    expect(row.text).toBeNull();
    expect(row.blobId).not.toBeNull();
  });

  it("no speech in the audio enriches clean instead of inventing words", async () => {
    const { captureId } = await voiceCapture();
    await runEnrichment(captureId, {
      transcriber: { name: "fixture:transcription", registryId: "fixture", transcribe: vi.fn(async () => ({ text: "" })) },
    });

    const row = await getCapture(captureId);
    expect(row.processingState).toBe("enriched");
    expect(row.text).toBeNull();
    expect(row.failureReason).toBeNull();
    expect(row.structure).toBe("empty");
  });
});
