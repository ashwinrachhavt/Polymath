import { and, desc, eq, isNull } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { embedArtifact } from "./embedding";
import { createNoteInTx } from "./notes";
import { artifactLinks, artifacts, documents } from "./schema";

/*
 * Passages: a span the reader selected in a document, kept as a zettel that
 * carries a `source` edge back to that document (the quote rides on the edge as
 * its context). There is no separate highlight store: a highlight is a zettel
 * with a source edge, so it is searched, related, linked and drawn on the
 * canvas like every other card, and the reader marks it by reading the edges.
 */

export const MAX_PASSAGE_CHARS = 2000;

export class PassageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassageError";
  }
}

export function passageTitle(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length <= 70 ? flat : `${flat.slice(0, 67).trimEnd()}...`;
}

export async function savePassageAsZettel(
  auth: AuthContext,
  input: { documentId: string; quote: string; comment?: string },
): Promise<{ artifactId: string; created: boolean }> {
  const quote = input.quote.replace(/\r/g, "").trim();
  if (!quote) throw new PassageError("Select some text first.");
  if (quote.length > MAX_PASSAGE_CHARS) throw new PassageError("That selection is too long to keep as one card.");

  const [doc] = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId), isNull(documents.archivedAt)))
    .limit(1);
  if (!doc) throw new PassageError("That document is no longer available.");

  // Saving the same passage twice returns the card it already made.
  const existing = await listPassages(auth, doc.id);
  const same = existing.find((p) => p.quote === quote);
  if (same) return { artifactId: same.artifactId, created: false };

  const comment = input.comment?.trim();
  const text = [quote.split("\n").map((l) => `> ${l}`).join("\n"), comment].filter(Boolean).join("\n\n");
  const created = await withTransaction(async (tx) => {
    const card = await createNoteInTx(tx, auth, {
      title: passageTitle(quote),
      content: { format: "markdown", text },
      plainText: text,
      kind: "zettel",
    });
    await tx.insert(artifactLinks).values({
      workspaceId: auth.workspaceId,
      artifactId: card.id,
      targetType: "document",
      targetId: doc.id,
      linkType: "source",
      label: doc.title,
      context: quote,
    });
    return card;
  });
  try {
    await embedArtifact(auth, { artifactId: created.id });
  } catch (cause) {
    console.error(`embedArtifact for passage failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return { artifactId: created.id, created: true };
}

export type Passage = { artifactId: string; title: string; quote: string };

/** The passages kept from one document, newest first. */
export async function listPassages(auth: AuthContext, documentId: string): Promise<Passage[]> {
  const rows = await db
    .select({ artifactId: artifacts.id, title: artifacts.title, quote: artifactLinks.context })
    .from(artifactLinks)
    .innerJoin(artifacts, eq(artifacts.id, artifactLinks.artifactId))
    .where(
      and(
        eq(artifactLinks.workspaceId, auth.workspaceId),
        eq(artifactLinks.targetType, "document"),
        eq(artifactLinks.targetId, documentId),
        eq(artifactLinks.linkType, "source"),
        eq(artifacts.kind, "zettel"),
        isNull(artifacts.archivedAt),
      ),
    )
    .orderBy(desc(artifacts.createdAt));
  return rows.flatMap((r) => (r.quote ? [{ artifactId: r.artifactId, title: r.title, quote: r.quote }] : []));
}

export type TextSegment = { text: string; passage: Passage | null };

/** Split the document text so each saved quote that still appears verbatim is marked. */
export function segmentText(text: string, passages: Passage[]): TextSegment[] {
  const spans: { start: number; end: number; passage: Passage }[] = [];
  for (const passage of passages) {
    const start = text.indexOf(passage.quote);
    if (start < 0) continue;
    const end = start + passage.quote.length;
    if (spans.some((s) => start < s.end && end > s.start)) continue;
    spans.push({ start, end, passage });
  }
  spans.sort((a, b) => a.start - b.start);
  const out: TextSegment[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.start > at) out.push({ text: text.slice(at, s.start), passage: null });
    out.push({ text: text.slice(s.start, s.end), passage: s.passage });
    at = s.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), passage: null });
  return out.length ? out : [{ text, passage: null }];
}
