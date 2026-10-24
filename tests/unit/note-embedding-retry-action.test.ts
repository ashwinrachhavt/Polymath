import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The retryNoteEmbeddingAction server action: member-guarded, tenant-scoped,
 * and honest about the embedding outcome. The action must map each domain
 * outcome to a distinct message - a success, an empty note, a provider
 * failure and a missing note never collapse into one blanket string.
 */

const getAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  return { ...original, getAuthContext };
});

const requireRole = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/guards", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/guards")>();
  return { ...original, requireRole };
});

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn(), refresh: vi.fn() }));
vi.mock("next/cache", () => cache);

const retryNoteEmbedding = vi.hoisted(() => vi.fn());
vi.mock("@/domains/knowledge/notes", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/domains/knowledge/notes")>();
  return { ...original, retryNoteEmbedding };
});

import { retryNoteEmbeddingAction } from "@/app/(workspace)/alfred/notes/actions";
import { NoteNotFoundError } from "@/domains/knowledge/notes";

const memberAuth = { userId: "u1", workspaceId: "w1", role: "member" as const };
const noteId = crypto.randomUUID();

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue(memberAuth);
});

describe("retryNoteEmbeddingAction", () => {
  it("requires member and passes the caller's auth and note id to the domain", async () => {
    retryNoteEmbedding.mockResolvedValue({ status: "succeeded", chunks: 2 });
    const result = await retryNoteEmbeddingAction({ artifactId: noteId });
    expect(requireRole).toHaveBeenCalledWith(memberAuth, "member");
    expect(retryNoteEmbedding).toHaveBeenCalledWith(memberAuth, { artifactId: noteId });
    expect(result).toEqual({ ok: true, message: "Indexed for meaning search." });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/alfred/notes");
  });

  it("rejects a malformed id before touching the domain", async () => {
    const result = await retryNoteEmbeddingAction({ artifactId: "nope" });
    expect(result).toEqual({ ok: false, error: "That note id is not valid." });
    expect(retryNoteEmbedding).not.toHaveBeenCalled();
  });

  it("reports an empty note as skipped, not as indexed", async () => {
    retryNoteEmbedding.mockResolvedValue({ status: "skipped", reason: "no_text" });
    const result = await retryNoteEmbeddingAction({ artifactId: noteId });
    expect(result).toEqual({ ok: false, error: "This note has no text to index yet." });
  });

  it("passes a provider failure through as the error, unvarnished", async () => {
    retryNoteEmbedding.mockResolvedValue({ status: "failed", error: "Embedding could not complete. Retry to try again." });
    const result = await retryNoteEmbeddingAction({ artifactId: noteId });
    expect(result).toEqual({ ok: false, error: "Embedding could not complete. Retry to try again." });
  });

  it("maps a note outside the workspace to the not-found message", async () => {
    retryNoteEmbedding.mockRejectedValue(new NoteNotFoundError());
    const result = await retryNoteEmbeddingAction({ artifactId: noteId });
    expect(result).toEqual({ ok: false, error: "That note does not exist in this workspace." });
  });

  it("reports a concurrent pass without pretending to have indexed", async () => {
    retryNoteEmbedding.mockResolvedValue({ status: "skipped", reason: "busy" });
    expect(await retryNoteEmbeddingAction({ artifactId: noteId })).toEqual({ ok: false, error: "Indexing is already in progress for this note." });
  });

  it("reports an edit that landed mid-indexing", async () => {
    retryNoteEmbedding.mockResolvedValue({ status: "skipped", reason: "edited" });
    expect(await retryNoteEmbeddingAction({ artifactId: noteId })).toEqual({ ok: false, error: "This note changed while indexing. Retry to index the latest version." });
  });

  it("never passes a raw provider payload to the UI", async () => {
    retryNoteEmbedding.mockResolvedValue({ status: "failed", error: "401 unauthorized: token sk-live-abc123 POST /v1/embeddings" });
    expect(await retryNoteEmbeddingAction({ artifactId: noteId })).toEqual({ ok: false, error: "Indexing failed. Retry to try again." });
  });
});

describe("safeArtifactEmbedError", () => {
  it("maps authored strings to themselves and anything else to the generic", async () => {
    const { safeArtifactEmbedError } = await import("@/domains/knowledge/embedding");
    expect(safeArtifactEmbedError(null)).toBeNull();
    expect(safeArtifactEmbedError("No embedding provider configured. Set OPENROUTER_API_KEY (or OPENAI_API_KEY).")).toBe("No embedding provider configured. Set OPENROUTER_API_KEY (or OPENAI_API_KEY).");
    expect(safeArtifactEmbedError("The embedding provider could not be set up.")).toBe("The embedding provider could not be set up.");
    expect(safeArtifactEmbedError("Embedding could not complete. Retry to try again.")).toBe("Embedding could not complete. Retry to try again.");
    expect(safeArtifactEmbedError("sk-live-abc123; SQL: select * from users")).toBe("Indexing failed. Retry to try again.");
  });
});
