import { useSyncExternalStore } from "react";

/*
 * The browser side of inline autocomplete: the request to the completion
 * route, and the writer's on/off preference. The preference is per browser
 * (localStorage), on by default; the route pausing itself (no provider, an
 * exhausted allowance, a rate limit) is remembered here so the editor stops
 * asking instead of failing on every pause.
 */

export type CompletionRequest = { title?: string; before: string; after: string };
export type CompleteFn = (request: CompletionRequest, signal: AbortSignal) => Promise<string>;

export type AutocompleteStatus = "ready" | "unavailable" | "paused";

const STORAGE_KEY = "polymath.autocomplete";
const PAUSE_MS = 5 * 60_000;

let pausedUntil = 0;
let unavailable = false;
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

function status(): AutocompleteStatus {
  if (unavailable) return "unavailable";
  return Date.now() < pausedUntil ? "paused" : "ready";
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
  const current = useSyncExternalStore(subscribe, status, () => "ready" as const);
  return { enabled, status: current };
}

export const fetchCompletion: CompleteFn = async (request, signal) => {
  if (status() !== "ready") return "";
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
    pausedUntil = Date.now() + PAUSE_MS;
    notify();
    return "";
  }
  if (!response.ok) return "";
  const body = (await response.json().catch(() => null)) as { completion?: unknown } | null;
  return typeof body?.completion === "string" ? body.completion : "";
};
