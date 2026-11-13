/*
 * How zettelize jobs are named: their kind, the subjects a surface lists them
 * by, and the per-request bound. No imports, so server code and client
 * components can both use it.
 */

export const ZETTEL_JOB_KIND_PREFIX = "zettels.";

export const ZETTEL_JOB_KIND = `${ZETTEL_JOB_KIND_PREFIX}source`;

/** One request is bounded the way learning sources are: the queue is not a batch API. */
export const MAX_ZETTELIZE_SOURCES = 20;

export type ZettelSource = { kind: "capture" | "document"; id: string };

/** The subject of the job made for one source: "capture:<id>" or "document:<id>". */
export function zettelJobSubject(source: ZettelSource): string {
  return `${source.kind}:${source.id}`;
}
