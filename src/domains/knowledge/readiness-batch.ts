import { z } from "zod";
import type { SourceReadiness } from "./source-readiness";

/*
 * Shared plumbing for GET /api/v1/documents/readiness and the client pollers
 * that call it (vault rows, notebook add-sources). Pure on purpose: the
 * validation and the readiness-to-copy mapping are the parts a test can pin
 * without a database; the workspace-scoped read itself is listSources.
 */

const MAX_IDS = 50;

const uuidSchema = z.string().uuid();

export type ParsedReadinessIds =
  | { ok: true; ids: string[] }
  | { ok: false; reason: string };

/** Parse the `?ids=` query: trim, drop blanks, dedupe, cap at 50, require UUIDs. */
export function parseReadinessIds(raw: string | null): ParsedReadinessIds {
  const ids = [...new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )];
  if (ids.length === 0) return { ok: false, reason: "Give ids as a comma-separated list of document ids." };
  if (ids.length > MAX_IDS) return { ok: false, reason: `Between 1 and ${MAX_IDS} document ids.` };
  if (ids.some((id) => !uuidSchema.safeParse(id).success)) {
    return { ok: false, reason: "Document ids must be UUIDs." };
  }
  return { ok: true, ids };
}

/**
 * One readiness → copy mapping for every polling surface, so the vault row and
 * the notebook status line never disagree. `terminal` is null while the
 * pipeline is still moving; "done"/"error" end the polling for that row.
 */
export function phaseForReadiness(
  readiness: SourceReadiness,
  detail: string | null,
): { phase: string; terminal: "done" | "error" | null } {
  switch (readiness) {
    case "queued":
      return { phase: "Queued", terminal: null };
    case "extracting":
      return { phase: "Reading…", terminal: null };
    case "embedding":
      return { phase: "Indexing for search…", terminal: null };
    case "ready":
      return { phase: "Ready", terminal: "done" };
    case "failed":
      return { phase: detail ?? "The source could not be read.", terminal: "error" };
    case "unsupported":
      return { phase: detail ?? "No reader accepts this source type.", terminal: "error" };
  }
}
