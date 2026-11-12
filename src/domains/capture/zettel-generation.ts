import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { submitGenerationJob } from "@/domains/jobs/commands";
import type { GenerationJobRunner } from "@/domains/jobs/runners";
import { GenerationJobFailure, type GenerationJobView } from "@/domains/jobs/state";
import { EmbeddingUnconfiguredError } from "@/integrations/embeddings/provider";
import type { ZettelExtractor } from "@/integrations/zettels/extractor";
import { extractDocument } from "@/domains/knowledge/extraction";
import { documents } from "@/domains/knowledge/schema";
import { createZettelsFromSource, type ZettelCardsResult } from "@/domains/knowledge/zettels";
import { db } from "@/lib/db";
import { displayTitle, titleFromText } from "@/lib/display-text";
import { ConflictError, StaleWriteError, convertCaptureToDocument } from "./commands";
import { captures } from "./schema";
import { MAX_ZETTELIZE_SOURCES, ZETTEL_JOB_KIND, zettelJobSubject, type ZettelSource } from "./zettel-job-names";

/*
 * Zettelize: turn a capture or a library document into idea cards, as a
 * generation job per source. The request picks the eligible sources and
 * submits one job for each, with no model call; the runner files a capture as
 * a document (a document is already one), reads it, and creates the cards.
 * The job row is the progress: the jobs stream moves it from waiting to ready
 * or failed on every open surface, and the shell announces it wherever the
 * person is by then.
 *
 * Nothing here proposes. The click is the permission, so the runner writes
 * the cards (the same authorship-is-acceptance pattern a chat save uses).
 * Dedupe stands in for review: a second pass lands on the cards the first one
 * made (same span, same dedupe key), and a near-duplicate of an existing card
 * is skipped rather than minted. A candidate whose quote is not verbatim in
 * the source's text is dropped rather than cited.
 */

/** The states an open capture can hold. Converted and archived rows are not sources. */
const OPEN_STATES = sql`${captures.processingState} in ('unprocessed', 'classifying', 'enriched', 'failed')`;

/**
 * The text a capture offers a model: enrichment's cleaned copy when it produced
 * one, the pasted body otherwise. Null for a file or an unfetched link - those
 * have no body, and the pass must skip rather than propose from a filename.
 * `zettelSourceWhere` expresses this same rule in SQL; keep the two in step.
 */
function zettelSourceText(capture: { cleanText: string | null; text: string | null }): string | null {
  return capture.cleanText?.trim() || capture.text?.trim() || null;
}

/** The open captures with text, tenant-scoped, narrowed to `ids`. */
function zettelSourceWhere(auth: AuthContext, ids: string[]) {
  // Same rule as zettelSourceText: the first of cleanText/text that is not blank.
  const hasText = sql`coalesce(nullif(trim(${captures.cleanText}), ''), nullif(trim(${captures.text}), '')) is not null`;
  const parts: SQL[] = [
    eq(captures.workspaceId, auth.workspaceId),
    OPEN_STATES,
    isNull(captures.archivedAt),
    isNull(captures.parkedAt),
    hasText,
    inArray(captures.id, ids),
  ];
  return and(...parts);
}

async function listZettelSourceCaptures(auth: AuthContext, input: { ids: string[] }) {
  if (input.ids.length === 0) return [];
  return db
    .select({ id: captures.id, title: captures.title, text: captures.text, cleanText: captures.cleanText })
    .from(captures)
    .where(zettelSourceWhere(auth, input.ids))
    .limit(MAX_ZETTELIZE_SOURCES);
}

/** Live library documents in the workspace, narrowed to `ids`. */
async function listZettelSourceDocuments(auth: AuthContext, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.workspaceId, auth.workspaceId), isNull(documents.archivedAt), inArray(documents.id, ids)))
    .limit(MAX_ZETTELIZE_SOURCES);
}

const MAX_TITLE_SOURCE_CHARS = 60;

/** A stored title when it is already plain words; null when it is blank or markup. */
function plainTitle(raw: string | null): string | null {
  const title = raw?.trim();
  return title && displayTitle(title) === title ? title : null;
}

/** What the job's row and its notice call the work. */
function zettelJobTitle(sourceTitle: string | null): string {
  const name = sourceTitle?.trim() || "Untitled";
  const short = name.length > MAX_TITLE_SOURCE_CHARS ? `${name.slice(0, MAX_TITLE_SOURCE_CHARS).trimEnd()}…` : name;
  return `Ideas: ${short}`;
}

export type ZettelJobsRequest = {
  /** One job per eligible source, in the order asked. */
  jobs: GenerationJobView[];
  /** Jobs this call created; the caller starts only these. A repeated key returns the first call's jobs. */
  created: GenerationJobView[];
  /** Sources that were not eligible (no text, archived, already filed elsewhere, not in this workspace). */
  skipped: number;
};

/**
 * Accepts zettelize work for later: one generation job per eligible source.
 * Idempotent per source on `idempotencyKey`, so a double-submit returns the
 * first jobs and queues nothing new.
 */
export async function requestZettelJobs(
  auth: AuthContext,
  input: { sources: ZettelSource[]; idempotencyKey: string },
): Promise<ZettelJobsRequest> {
  const unique = [...new Map(input.sources.map((s) => [`${s.kind}:${s.id}`, s])).values()].slice(
    0,
    MAX_ZETTELIZE_SOURCES,
  );
  const captureIds = unique.filter((s) => s.kind === "capture").map((s) => s.id);
  const documentIds = unique.filter((s) => s.kind === "document").map((s) => s.id);
  const [captureRows, documentRows] = await Promise.all([
    listZettelSourceCaptures(auth, { ids: captureIds }),
    listZettelSourceDocuments(auth, documentIds),
  ]);
  // A stored title can be raw markup ("> ## Documentation Index"); the row names the source in plain words.
  const titles = new Map<string, string | null>([
    ...captureRows.map((row): [string, string | null] => [
      `capture:${row.id}`,
      plainTitle(row.title) ?? titleFromText(zettelSourceText(row) ?? "", "Untitled capture"),
    ]),
    ...documentRows.map((row): [string, string | null] => [`document:${row.id}`, plainTitle(row.title)]),
  ]);

  const jobs: GenerationJobView[] = [];
  const created: GenerationJobView[] = [];
  for (const source of unique) {
    const key = `${source.kind}:${source.id}`;
    if (!titles.has(key)) continue;
    const submitted = await submitGenerationJob(auth, {
      kind: ZETTEL_JOB_KIND,
      subject: zettelJobSubject(source),
      idempotencyKey: `zettelize:${input.idempotencyKey}:${key}`,
      title: zettelJobTitle(titles.get(key) ?? null),
      input: { source },
    });
    jobs.push(submitted.job);
    if (submitted.created) created.push(submitted.job);
  }
  return { jobs, created, skipped: input.sources.length - jobs.length };
}

export type ZettelizeDeps = {
  /** Test seam: a fake extractor keeps the pass free and deterministic. */
  extractor?: ZettelExtractor;
};

/**
 * The library document a capture's cards cite. A capture that already became
 * a task, note, or draft keeps that home - the owner chose it, and filing a
 * second document would be a silent duplicate. A capture that never became a
 * document is filed through the one intake path, so its text, extraction,
 * lineage edge, and audit row are the ordinary ones.
 */
async function documentForCapture(auth: AuthContext, captureId: string): Promise<string> {
  const [capture] = await db
    .select()
    .from(captures)
    .where(and(eq(captures.id, captureId), eq(captures.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!capture || capture.archivedAt || capture.processingState === "discarded") {
    throw new GenerationJobFailure("That capture was archived before its ideas were made.");
  }
  if (capture.convertedType === "document" && capture.convertedId) return capture.convertedId;
  if (capture.convertedType) {
    throw new GenerationJobFailure("That capture became a task, note or draft first, so it has no document to read.");
  }
  if (!zettelSourceText(capture)) throw new GenerationJobFailure("That capture has no text to read yet.");
  try {
    const filed = await convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: capture.version });
    if (filed.documentId) return filed.documentId;
    throw new GenerationJobFailure("That capture could not be filed as a document.");
  } catch (cause) {
    if (!(cause instanceof ConflictError) && !(cause instanceof StaleWriteError)) throw cause;
    // Someone filed or edited it between the read and the write: read again and use what landed.
    const [again] = await db
      .select({ convertedType: captures.convertedType, convertedId: captures.convertedId, version: captures.version })
      .from(captures)
      .where(eq(captures.id, capture.id))
      .limit(1);
    if (again?.convertedType === "document" && again.convertedId) return again.convertedId;
    if (again && !again.convertedType && cause instanceof StaleWriteError) {
      const filed = await convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: again.version });
      if (filed.documentId) return filed.documentId;
    }
    throw new GenerationJobFailure(cause.message);
  }
}

/**
 * One source in, cards out. Returns the pass so the caller can say what it
 * made; zero cards is a normal answer (no claims, or every candidate was a
 * repeat). Authored failures throw GenerationJobFailure.
 */
export async function zettelizeSource(
  auth: AuthContext,
  source: ZettelSource,
  deps: ZettelizeDeps = {},
): Promise<ZettelCardsResult & { documentId: string }> {
  const documentId = source.kind === "capture" ? await documentForCapture(auth, source.id) : source.id;

  const extraction = await extractDocument(auth, { documentId });
  if (!extraction.ok) throw new GenerationJobFailure(`The text could not be read: ${extraction.error}`);

  let pass: ZettelCardsResult;
  try {
    pass = await createZettelsFromSource(auth, { documentId, extractor: deps.extractor });
  } catch (cause) {
    if (cause instanceof EmbeddingUnconfiguredError) {
      throw new GenerationJobFailure("Ideas need a search model, and none is configured for this workspace.");
    }
    throw cause;
  }

  if (pass.created.length > 0) {
    await recordAudit(auth, {
      action: source.kind === "capture" ? "capture.zettels_created" : "document.zettels_created",
      subjectType: source.kind,
      subjectId: source.id,
      summary: `Created ${pass.created.length} zettel${pass.created.length === 1 ? "" : "s"}`,
      metadata: {
        documentId,
        readChars: pass.readChars,
        unreadChars: pass.unreadChars,
        unreadSections: pass.unreadSections,
        skippedRepeats: pass.skippedRepeats,
        skippedDuplicates: pass.skippedDuplicates,
        skippedSpans: pass.skippedSpans,
      },
    });
  }
  return { ...pass, documentId };
}

const ideas = (n: number) => `${n} idea${n === 1 ? "" : "s"}`;

/**
 * What the person is told when the job is ready. Filing a capture runs the
 * extraction pipeline, which may make the cards before this pass reads the
 * document; those come back as repeats or near-duplicates, so they are
 * reported as already in Ideas rather than as nothing made.
 */
function zettelJobNotice(
  pass: Pick<ZettelCardsResult, "created" | "skippedRepeats" | "skippedDuplicates" | "unreadChars">,
): string {
  const made = pass.created.length;
  // Same span (a repeat) or the same idea in other words (a near-duplicate): either way it is already a card.
  const already = pass.skippedRepeats + pass.skippedDuplicates;
  const base =
    made > 0 && already > 0
      ? `${ideas(made)} added to Ideas; ${already} were already there.`
      : made > 0
        ? `${ideas(made)} added to Ideas.`
        : already > 0
          ? `Its ${ideas(already)} ${already === 1 ? "is" : "are"} in Ideas.`
          : "No ideas to keep: it makes no claims a card could cite.";
  return pass.unreadChars > 0 ? `${base} It was long, so only the start was read.` : base;
}

const jobInput = z.object({
  source: z.object({ kind: z.enum(["capture", "document"]), id: z.uuid() }),
});

const zettelizeRunner: GenerationJobRunner = async (auth, raw) => {
  const parsed = jobInput.safeParse(raw);
  if (!parsed.success) throw new Error("malformed zettelize job input");
  const pass = await zettelizeSource(auth, parsed.data.source);
  return { href: "/polymath/ideas", notice: zettelJobNotice(pass) };
};

export const zettelJobRunners: Record<string, GenerationJobRunner> = {
  [ZETTEL_JOB_KIND]: zettelizeRunner,
};
