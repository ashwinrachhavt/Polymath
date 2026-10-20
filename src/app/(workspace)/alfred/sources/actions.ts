"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { captureUrl } from "@/domains/knowledge/capture-url";
import { enqueueOutbox } from "@/domains/audit/outbox";
import { queueYouTubeCapture } from "@/domains/knowledge/youtube-capture";
import { URL_IMPORT_TOPIC } from "@/domains/knowledge/youtube-handler";
import { webSearchProvider, WebSearchError } from "@/integrations/search/provider";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { withTransaction } from "@/lib/db-transaction";

/*
 * The source-discovery mutation surface (NotebookLM parity, S2).
 *
 * Two rules hold:
 *   - nothing long happens in the request. A search is one bounded provider
 *     call; every import is queued, not fetched here.
 *   - a batch is all-or-nothing into the queue. Ten selected results either all
 *     become queued sources or none do, so the owner never has to guess which
 *     half landed.
 */

const revalidate = () => revalidatePath("/alfred/sources");

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

export type SearchActionState = { results: Array<{ title: string; url: string; snippet: string }>; error: string | null };

/** One search, bounded, read-only. */
export async function searchSources(query: string): Promise<SearchActionState> {
  await authorize();
  const q = query.trim();
  if (!q) return { results: [], error: "Give the search a query." };
  try {
    const provider = webSearchProvider();
    const results = await provider.search(q, 10);
    return {
      results: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
      error: null,
    };
  } catch (cause) {
    // Provider text can carry account details; the owner gets a stated failure.
    if (cause instanceof WebSearchError) return { results: [], error: "Search failed. Try again, or paste a link instead." };
    return { results: [], error: "Search is not configured. Paste a link instead." };
  }
}

export type ImportState = { ok: boolean; imported: number; failed: number; error: string | null };

/**
 * Imports selected results. Each one enters the queue in the same transaction,
 * so a provider failure before the write leaves nothing half-imported. The
 * per-URL outcomes come back so a partial provider failure is labelled.
 */
export async function importSources(urls: string[]): Promise<ImportState> {
  const auth = await authorize();
  const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(0, 20);
  if (unique.length === 0) return { ok: false, imported: 0, failed: 0, error: "Select at least one result." };

  const YouTube = unique.filter((u) => queueYouTubeCaptureIsVideo(u));
  const web = unique.filter((u) => !queueYouTubeCaptureIsVideo(u));

  let imported = 0;
  const failures: string[] = [];

  for (const url of YouTube) {
    const out = await queueYouTubeCapture(auth, { url });
    if (out.ok) imported += 1;
    else failures.push(`${url}: ${out.error}`);
  }

  if (web.length > 0) {
    try {
      await withTransaction(async (tx) => {
        for (const url of web) {
          await enqueueOutbox(tx, auth, {
            topic: URL_IMPORT_TOPIC,
            payload: { url },
            dispatchKey: `import:${auth.workspaceId}:${url}`,
          });
        }
      });
      imported += web.length;
    } catch {
      failures.push(...web.map((u) => `${u}: could not be queued`));
    }
  }

  revalidate();
  return {
    ok: failures.length === 0,
    imported,
    failed: failures.length,
    error: failures.length ? `${imported} queued, ${failures.length} failed. ${failures.slice(0, 3).join(" ")}` : null,
  };
}

/** Pasting one link: YouTube is queued; any other URL is captured inline. */
export async function addSource(url: string): Promise<{ ok: boolean; message: string }> {
  const auth = await authorize();
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, message: "Paste a link first." };

  if (queueYouTubeCaptureIsVideo(trimmed)) {
    const out = await queueYouTubeCapture(auth, { url: trimmed });
    revalidate();
    return out.ok
      ? { ok: true, message: out.enqueued ? "Video queued. The transcript lands in a moment." : "That video is already filed." }
      : { ok: false, message: out.error };
  }

  const result = await captureUrl(auth, { url: trimmed });
  revalidate();
  return result.ok
    ? { ok: true, message: "Source captured." }
    : { ok: false, message: result.error };
}

function queueYouTubeCaptureIsVideo(url: string): boolean {
  // Local, synchronous check so this module does not import the adapter's
  // network code into the search path.
  return /(^|\.)youtube\.com\//.test(url) || /^https?:\/\/youtu\.be\//.test(url);
}

/** Re-queues a source whose extraction failed or never ran. */
export async function retrySource(documentId: string): Promise<{ ok: boolean; message: string }> {
  const auth = await authorize();
  const parsed = z.string().uuid().safeParse(documentId);
  if (!parsed.success) return { ok: false, message: "That source id is not valid." };
  await withTransaction(async (tx) => {
    await enqueueOutbox(tx, auth, {
      topic: "document.extraction_requested",
      payload: { documentId: parsed.data },
      dispatchKey: `retry:${auth.workspaceId}:${parsed.data}:${Date.now()}`,
    });
  });
  revalidate();
  return { ok: true, message: "Queued for another attempt." };
}
