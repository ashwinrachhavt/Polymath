"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ingestDocument, lintWiki, WikiError } from "@/domains/knowledge/wiki";
import { EmbeddingUnconfiguredError } from "@/integrations/embeddings/provider";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * The wiki's mutation surface. Ingest is a write, so it requires member or
 * above; lint is a read and stays viewer-safe through the page itself.
 * Resource scope lives in the domain: every read and write filters on the
 * caller's workspace, so a foreign document id is "not found".
 */

const topicsSchema = z
  .array(z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,60}$/))
  .max(5);

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

export type IngestActionResult = { ok: boolean; message: string };

export async function ingestDocumentAction(documentId: string, topics: string[]): Promise<IngestActionResult> {
  const parsed = z.object({ documentId: z.string().uuid(), topics: topicsSchema }).parse({ documentId, topics });
  const auth = await authorize();
  try {
    const result = await ingestDocument(auth, {
      documentId: parsed.documentId,
      topics: parsed.topics.length ? parsed.topics : undefined,
    });
    revalidatePath("/alfred/wiki");
    return {
      ok: true,
      message: result.changed
        ? `Ingested "${result.title}" into ${result.topics.join(", ")}.`
        : `"${result.title}" was already ingested from this text; topics refreshed.`,
    };
  } catch (cause) {
    if (cause instanceof WikiError) {
      const messages: Record<WikiError["code"], string> = {
        document_not_found: "That document is not in this workspace.",
        no_extraction: "This document has not been read yet. Extract it in Knowledge first.",
        no_topics: "No usable topic came back. Name one explicitly.",
        invalid_topic: "Topics are lowercase words joined by hyphens.",
        page_not_found: "A wiki page went missing. Run lint to see the damage.",
      };
      return { ok: false, message: messages[cause.code] };
    }
    if (cause instanceof EmbeddingUnconfiguredError) {
      return { ok: false, message: "No summarizer is configured (OPENROUTER_API_KEY). The wiki cannot write articles without one." };
    }
    throw cause;
  }
}

export type LintActionResult = { ok: true; findings: { code: string; message: string }[] };

export async function lintWikiAction(): Promise<LintActionResult> {
  const auth = await authorize();
  const findings = await lintWiki(auth);
  return { ok: true, findings: findings.map(({ code, message }) => ({ code, message })) };
}
