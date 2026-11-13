/*
 * What one tool call looked like to the person watching: the query it asked
 * and the sources that came back. The chat's step card (components/chat/
 * agent-steps.tsx) renders these facts, live from the stream and again from
 * tool_calls after a reload, so both paths go through `stepFacts` and cannot
 * describe the same call two ways.
 *
 * Pure and dependency-free: stream-contract.ts imports it, and that module
 * ships in the browser bundle.
 *
 * The facts are read from the tool's own argument and result shapes, never
 * inferred: a call whose result has no recognisable sources shows none rather
 * than a guess.
 */

/** One source a step read or found. A web source has a url; a library passage has a documentId. */
export type StepSource = { title: string; url?: string; documentId?: string };

export type StepKind = "search" | "read" | "tool";

export type StepFacts = {
  kind: StepKind;
  /** The query searched, or the page or record read; null when the call names neither. */
  query: string | null;
  sources: StepSource[];
  /**
   * The tool's own failure line when it answered `{ ok: false, error }`. Eve
   * reports such a call as completed (the tool returned rather than threw),
   * but to the person it is a search that failed, not one that finished.
   */
  failure: string | null;
};

const MAX_FAILURE = 120;

/** Per step, so a ten-result search cannot make every frame and every reload heavy. */
export const MAX_STEP_SOURCES = 12;
const MAX_TEXT = 300;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, MAX_TEXT) : null;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function stepKind(toolName: string): StepKind {
  if (/search/i.test(toolName)) return "search";
  if (/fetch|_read|\.read|read_/i.test(toolName)) return "read";
  return "tool";
}

/** The host a url names, without "www."; null for anything that is not an http(s) url. */
export function sourceHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function sourceOf(value: unknown): StepSource | null {
  const item = record(value);
  if (!item) return null;
  const url = text(item.url);
  const documentId = text(item.documentId);
  const webUrl = url && sourceHost(url) ? url : null;
  if (!webUrl && !documentId) return null;
  const title = text(item.title) ?? (webUrl ? (sourceHost(webUrl) ?? webUrl) : "Untitled document");
  return { title, ...(webUrl ? { url: webUrl } : {}), ...(documentId ? { documentId } : {}) };
}

/** Distinct sources, in result order: one entry per page or document, not per passage. */
function sourcesOf(output: unknown): StepSource[] {
  const body = record(output);
  if (!body || body.ok === false) return [];
  const list = Array.isArray(body.results) ? body.results : Array.isArray(body.pages) ? body.pages : [body];
  const seen = new Set<string>();
  const out: StepSource[] = [];
  for (const item of list) {
    const source = sourceOf(item);
    if (!source) continue;
    const key = source.documentId ?? source.url ?? source.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
    if (out.length === MAX_STEP_SOURCES) break;
  }
  return out;
}

function queryOf(input: unknown, output: unknown): string | null {
  const args = record(input);
  const body = record(output);
  return text(args?.query) ?? text(args?.url) ?? text(args?.title) ?? text(args?.slug) ?? text(body?.query) ?? null;
}

/**
 * The step facts for a call. `input` is the call's arguments when known (the
 * running frame, or the stored row); `output` is its result when settled.
 */
export function stepFacts(toolName: string, input: unknown, output: unknown): StepFacts {
  const body = record(output);
  const failure = body?.ok === false ? (text(body.error)?.slice(0, MAX_FAILURE) ?? "failed") : null;
  return { kind: stepKind(toolName), query: queryOf(input, output), sources: sourcesOf(output), failure };
}

/**
 * Two partial views of one call, combined: the running frame knows the query,
 * the settled frame knows the sources. A side that learned nothing never
 * erases what the other already showed.
 */
export function mergeStepFacts(previous: StepFacts | undefined, next: StepFacts | undefined): StepFacts | undefined {
  if (!previous) return next;
  if (!next) return previous;
  return {
    kind: next.kind,
    query: next.query ?? previous.query,
    sources: next.sources.length > 0 ? next.sources : previous.sources,
    failure: next.failure ?? previous.failure,
  };
}

/** A settled call as tool_calls recorded it: what a reload seeds the step card with. */
export type RecordedStep = {
  callId: string;
  turnId: string;
  label: string;
  status: "ok" | "error";
  detail: string;
  facts: StepFacts;
};
