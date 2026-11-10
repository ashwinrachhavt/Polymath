import { useSyncExternalStore } from "react";

/*
 * The browser side of inline autocomplete: the request to the completion
 * route, and the writer's on/off preference. The preference is per browser
 * (localStorage), on by default; the route pausing itself (no provider, an
 * exhausted allowance, a rate limit) is remembered here so the editor stops
 * asking instead of failing on every pause.
 */

type CompletionRequest = { title?: string; before: string; after: string };
export type CompleteFn = (request: CompletionRequest, signal: AbortSignal) => Promise<string>;

/*
 * "silent": the route keeps answering with no reply from the model at all
 * (provider failing, timing out, or sending empty text). Requests continue so
 * it recovers on its own, but the toggle stops claiming suggestions are on.
 */
export type AutocompleteStatus = "ready" | "unavailable" | "paused" | "silent";

const STORAGE_KEY = "polymath.autocomplete";
const PAUSE_MS = 5 * 60_000;
const RATE_LIMIT_PAUSE_MS = 20_000;

/** Consecutive no-answer replies before the toggle says suggestions are not arriving. */
const SILENT_AFTER = 3;

let pausedUntil = 0;
let unavailable = false;
let unanswered = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function autocompleteEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAutocompleteEnabled(on: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  notify();
}

/** Whether the route can serve suggestions right now (exported for tests). */
export function autocompleteStatus(): AutocompleteStatus {
  if (unavailable) return "unavailable";
  if (Date.now() < pausedUntil) return "paused";
  return unanswered >= SILENT_AFTER ? "silent" : "ready";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The preference and the route's availability, live across editors and tabs. */
export function useAutocomplete(): { enabled: boolean; status: AutocompleteStatus } {
  const enabled = useSyncExternalStore(subscribe, autocompleteEnabled, () => true);
  const current = useSyncExternalStore(subscribe, autocompleteStatus, () => "ready" as const);
  return { enabled, status: current };
}

function recordAnswer(answered: boolean) {
  const was = autocompleteStatus();
  unanswered = answered ? 0 : unanswered + 1;
  if (autocompleteStatus() !== was) notify();
}

export const fetchCompletion: CompleteFn = async (request, signal) => {
  const current = autocompleteStatus();
  if (current !== "ready" && current !== "silent") return "";
  const response = await fetch("/api/v1/notes/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (response.status === 503) {
    unavailable = true;
    notify();
    return "";
  }
  if (response.status === 429) {
    // The per-minute brake reopens in seconds; only a spent allowance waits long.
    const problem = (await response.json().catch(() => null)) as { code?: unknown } | null;
    const wait = problem?.code === "rate_limited" ? RATE_LIMIT_PAUSE_MS : PAUSE_MS;
    pausedUntil = Date.now() + wait;
    notify();
    // Nothing else changes when the pause lapses, so say so then.
    setTimeout(notify, wait + 50);
    return "";
  }
  if (!response.ok) {
    recordAnswer(false);
    return "";
  }
  const body = (await response.json().catch(() => null)) as { completion?: unknown; answered?: unknown } | null;
  recordAnswer(body?.answered !== false && typeof body?.completion === "string");
  return typeof body?.completion === "string" ? body.completion : "";
};
