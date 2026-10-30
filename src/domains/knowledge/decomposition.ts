import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { IdempotencyConflictError, withReceipt } from "@/domains/audit/receipt";
import { requestReceipts } from "@/domains/audit/schema";
import { createTask } from "@/domains/work/commands";
import { artifactLinks, artifacts } from "./schema";
import { commitNoteSnapshot, createNote, getNote } from "./notes";

/*
 * Decomposition (§4): a proposal-generating compiler for a pasted or selected
 * text. Analysis writes nothing; commit turns the owner's decisions into
 * routed destinations (principle -> zettel, decision record -> note, checklist
 * -> task, never a zettel).
 *
 * The invariants are the extractor's, extended: no invented quotes (every
 * candidate's quotes are re-located verbatim in the source; an unlocatable
 * quote drops the candidate), multiple passages may support one candidate,
 * omitted material is surfaced with its reason, and extraction and synthesis
 * are distinguished.
 *
 * This module used to also carry the retired creation-flow entry points (the
 * paste analyzer, its size cap, and the quota-wired decomposer). Those left
 * with the flow itself; what remains is the document-facing analysis and the
 * commit/merge/link decisions a review surface drives.
 */

export type DecompositionRole = "principle" | "decision" | "checklist";
export type DecompositionSpan = { start: number; end: number; quote: string };
export type DecompositionCandidate = {
  /** Dedupe key: source hash + span (§4). Stable across re-analysis of the same paste. */
  id: string;
  role: DecompositionRole;
  kind: "extraction" | "synthesis";
  title: string;
  content: string;
  spans: DecompositionSpan[];
  /*
   * Existing zettels that look related (§4: "similarity candidates shown,
   * not asserted"). A title-overlap hint for the review UI's merge/link
   * choices; never an auto-decision.
   */
  similar: { id: string; title: string }[];
};
export type DecompositionAnalysis = {
  candidates: DecompositionCandidate[];
  /** Material the pass consciously left out, with the model's reason. */
  omitted: { quote: string; reason: string }[];
  sourceHash: string;
};

export const sourceHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The verbatim-locate (§4): a quote that is not really in the source is dropped, never trusted. */
export function locateSpan(text: string, quote: string): DecompositionSpan | null {
  const start = text.indexOf(quote);
  if (start < 0) return null;
  return { start, end: start + quote.length, quote };
}

/**
 * The answer shape every analysis starts from. Exported because the model call
 * that produced it left with the sitting pipeline: a future document-facing
 * entry point parses its answer with this, and the analysis below stays a pure
 * function of already-validated data.
 */
export const decompositionResponseSchema = z.object({
  candidates: z.array(
    z.object({
      role: z.enum(["principle", "decision", "checklist"]),
      kind: z.enum(["extraction", "synthesis"]),
      title: z.string().min(1).max(160),
      content: z.string().min(1),
      quotes: z.array(z.string().min(1)).min(1),
    }),
  ),
  omitted: z.array(z.object({ quote: z.string().min(1), reason: z.string().min(1) })).default([]),
});

/*
 * Analysis writes nothing. Unlocatable quotes drop their candidate; omitted
 * passages are re-located the same way so the "omitted" list can never invent
 * content either.
 */
export function analyzePaste(text: string, raw: z.infer<typeof decompositionResponseSchema>): DecompositionAnalysis {
  const hash = sourceHash(text);
  const candidates: DecompositionCandidate[] = [];
  for (const candidate of raw.candidates) {
    const spans = candidate.quotes.map((q) => locateSpan(text, q)).filter((s): s is DecompositionSpan => s !== null);
    if (spans.length === 0) continue; // no verbatim support: no proposal
    const first = spans[0];
    const id = createHash("sha256").update(`${hash}:${first.start}:${first.end}:${candidate.title}`).digest("hex").slice(0, 24);
    candidates.push({ id, role: candidate.role, kind: candidate.kind, title: candidate.title, content: candidate.content, spans, similar: [] });
  }
  const omitted = raw.omitted
    .map((o) => ({ ...o, span: locateSpan(text, o.quote) }))
    .filter((o) => o.span !== null)
    .map(({ quote, reason }) => ({ quote, reason }));
  return { candidates, omitted, sourceHash: hash };
}

/*
 * Title-overlap similarity (§4): whole distinctive words from the candidate
 * title against existing zettel titles, best-effort. Shown to the reviewer,
 * never asserted - the merge/link decision stays the user's.
 */
export async function findSimilarZettels(
  auth: AuthContext,
  title: string,
  limit = 3,
): Promise<{ id: string; title: string }[]> {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3)
    .slice(0, 4);
  if (words.length === 0) return [];
  const rows = await db
    .select({ id: artifacts.id, title: artifacts.title })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.workspaceId, auth.workspaceId),
        eq(artifacts.kind, "zettel"),
        isNull(artifacts.archivedAt),
        or(...words.map((w) => sql`position(${w} in lower(${artifacts.title})) > 0`))!,
      ),
    )
    .limit(limit);
  return rows;
}

export type DecompositionDecision =
  | { candidateId: string; action: "skip" }
  | { candidateId: string; action: "create" }
  /** Fold the candidate into an existing zettel as a new version (§4 merge). */
  | { candidateId: string; action: "merge"; targetArtifactId: string }
  /** Create the candidate's card and record an explicit related edge (§4 link). */
  | { candidateId: string; action: "link"; targetArtifactId: string };

/*
 * The batch commit (§4): each accepted candidate becomes its routed
 * destination, and the idempotency key rides the dedupe id (document/source
 * + span) so a retried batch creates one card per span, never two. Merge
 * folds the candidate into an existing zettel through the canonical version
 * machinery (commitNoteSnapshot - kind untouched, expectedVersion claimed,
 * receipt-keyed); link creates the card and records an explicit "related"
 * edge the semantic pass will not overwrite.
 */
export async function commitDecomposition(
  auth: AuthContext,
  input: { analysis: DecompositionAnalysis; decisions: DecompositionDecision[]; idempotencyKey: string },
): Promise<{
  created: { candidateId: string; destination: "zettel" | "note" | "task"; id: string }[];
  merged: { candidateId: string; targetId: string; versionNumber: number }[];
  linked: { candidateId: string; id: string; targetId: string }[];
  skipped: string[];
}> {
  const created: { candidateId: string; destination: "zettel" | "note" | "task"; id: string }[] = [];
  const merged: { candidateId: string; targetId: string; versionNumber: number }[] = [];
  const linked: { candidateId: string; id: string; targetId: string }[] = [];
  const skipped: string[] = [];
  for (const decision of input.decisions) {
    const candidate = input.analysis.candidates.find((c) => c.id === decision.candidateId);
    if (!candidate) continue;
    if (decision.action === "skip") {
      skipped.push(candidate.id);
      continue;
    }
    const key = `${input.idempotencyKey}:${candidate.id}`;
    const body = `${candidate.content}\n\n> ${candidate.spans.map((s) => s.quote).join("\n>\n> ")}`;
    if (decision.action === "merge") {
      /*
       * Merge targets only ever come from the review UI's similarity list,
       * but the guard is server-side regardless: the target must be a live
       * zettel in this workspace (getNote enforces kind + workspace), so a
       * merge can never convert a foreign or non-card artifact.
       */
      const target = await getNote(auth, decision.targetArtifactId);
      if (!target || target.kind !== "zettel") throw new Error("The card to merge into no longer exists.");
      const existing = (target.content as { content?: unknown[] } | null)?.content ?? [];
      try {
        const snapshot = await commitNoteSnapshot(auth, {
          idempotencyKey: `${key}:merge`,
          artifactId: target.id,
          expectedVersion: target.version,
          content: {
            type: "doc",
            content: [
              ...existing,
              { type: "paragraph", content: [{ type: "text", text: candidate.content }] },
              { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: candidate.spans.map((sp) => sp.quote).join("\n") }]}] },
            ],
          },
          note: `Merged decomposition candidate: ${candidate.title}`,
        });
        merged.push({ candidateId: candidate.id, targetId: target.id, versionNumber: snapshot.versionNumber });
      } catch (error) {
        /*
         * A retried batch re-derives expectedVersion from the moved head, so
         * the snapshot receipt's request hash differs from the first merge's
         * even though the decision is identical. The receipt for this exact
         * candidate key is the proof the merge already landed: replay its
         * recorded version instead of folding the content in twice.
         */
        if (!(error instanceof IdempotencyConflictError)) throw error;
        const [receipt] = await db
          .select({ response: requestReceipts.response })
          .from(requestReceipts)
          .where(and(eq(requestReceipts.workspaceId, auth.workspaceId), eq(requestReceipts.idempotencyKey, `${key}:merge`)))
          .limit(1);
        if (!receipt) throw error;
        const prior = receipt.response as { versionNumber: number };
        merged.push({ candidateId: candidate.id, targetId: target.id, versionNumber: prior.versionNumber });
      }
      continue;
    }
    if (candidate.role === "checklist") {
      // createTask refuses the global pool (rank assignment needs a
      // transaction), and a UI retry of this commit must replay the same
      // task instead of inserting a duplicate: receipt the create inside
      // one transaction, keyed off the commit's idempotency key.
      const { value: taskReceipt } = await withTransaction((tx) =>
        withReceipt<{ taskId: string }>(
          tx,
          auth,
          `${key}:task`,
          { op: "createDecompositionTask", title: candidate.title },
          async () => {
            const task = await createTask(
              auth,
              { title: candidate.title, description: body, tags: ["decomposed"] },
              tx,
            );
            return { taskId: task.id };
          },
        ),
      );
      created.push({ candidateId: candidate.id, destination: "task", id: taskReceipt.taskId });
    } else if (candidate.role === "decision") {
      const note = await createNote(auth, {
        idempotencyKey: key,
        title: candidate.title,
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] },
        plainText: body,
        kind: "note",
      });
      created.push({ candidateId: candidate.id, destination: "note", id: note.id });
    } else {
      const note = await createNote(auth, {
        idempotencyKey: key,
        title: candidate.title,
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] },
        plainText: body,
        kind: "zettel",
      });
      created.push({ candidateId: candidate.id, destination: "zettel", id: note.id });
      if (decision.action === "link") {
        // Same server-side guard as merge: the edge target must be a live
        // zettel here. onConflictDoNothing keeps a retried batch idempotent
        // against the (artifact, target) unique edge key.
        const target = await getNote(auth, decision.targetArtifactId);
        if (!target || target.kind !== "zettel") throw new Error("The card to link to no longer exists.");
        await withTransaction(async (tx: TxDrizzle) => {
          await tx
            .insert(artifactLinks)
            .values({
              workspaceId: auth.workspaceId,
              artifactId: note.id,
              targetType: "note",
              targetId: target.id,
              linkType: "related",
              label: target.title,
              context: `Linked from decomposition of pasted material: ${candidate.title}`,
            })
            .onConflictDoNothing();
        });
        linked.push({ candidateId: candidate.id, id: note.id, targetId: target.id });
      }
    }
  }
  return { created, merged, linked, skipped };
}
