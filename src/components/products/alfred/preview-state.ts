"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import { useWorkspace } from "@/components/workspace/workspace-provider";

const sourcePin = z.object({ id: z.string(), title: z.string(), body: z.string(), version: z.number().int().positive(), at: z.string() });
const schema = z.object({
  pins: z.record(z.string(), z.array(sourcePin)),
  annotations: z.record(z.string(), z.string()),
  attempts: z.array(z.object({ id: z.string(), mode: z.enum(["flashcard", "quiz"]), result: z.string(), at: z.string() })),
});
export type SourcePin = z.infer<typeof sourcePin>;
type AlfredPreview = z.infer<typeof schema>;

export function createAlfredPreview(storageScope: string) {
  // Never adopt the old unscoped key: its contents may belong to a previous owner.
  const key = `axiom-alfred-preview-v1:${encodeURIComponent(storageScope)}`;
  const initial: AlfredPreview = { pins: {}, annotations: {}, attempts: [] };
  let state = initial;
  let loaded = false;
  let lastRaw: string | null = null;
  let storageWarning = "";
  const listeners = new Set<() => void>();
  function onStorage(event: StorageEvent) { if (event.key === key || event.key === null) { getSnapshot(); publish(); } }
  function subscribe(listener: () => void) {
    if (!listeners.size && typeof window !== "undefined") window.addEventListener("storage", onStorage);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    };
  }
  function publish() { listeners.forEach((listener) => listener()); }
  function getSnapshot() {
    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(key);
        if (!loaded || raw !== lastRaw) {
          loaded = true;
          lastRaw = raw;
          if (raw) {
            const result = schema.safeParse(JSON.parse(raw));
            if (result.success) state = result.data;
            else storageWarning = "Saved metadata has an incompatible format. Export open feature history before replacing it.";
          } else state = initial;
        }
      } catch { storageWarning = "Preview storage is unavailable. Keep this tab open and export feature history before refreshing."; }
    }
    return state;
  }
  function update(change: (current: AlfredPreview) => AlfredPreview) {
    // Re-read before applying the change so another tab's independent metadata survives.
    state = change(getSnapshot());
    try {
      const raw = JSON.stringify(state);
      localStorage.setItem(key, raw);
      lastRaw = raw;
      loaded = true;
      storageWarning = "";
    } catch { storageWarning = "Feature history could not be saved. Keep this tab open and export it; refreshing will lose unsaved changes."; }
    publish();
  }
  return { subscribe, getSnapshot, getServerSnapshot: () => initial, getStorageWarning: () => storageWarning, update };
}

const stores = new Map<string, ReturnType<typeof createAlfredPreview>>();
export function useAlfredPreview() {
  const { storageScope, notify } = useWorkspace();
  const store = useMemo(() => {
    let scoped = stores.get(storageScope);
    if (!scoped) { scoped = createAlfredPreview(storageScope); stores.set(storageScope, scoped); }
    return scoped;
  }, [storageScope]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const storageWarning = useSyncExternalStore(store.subscribe, store.getStorageWarning, () => "");
  useEffect(() => { if (storageWarning) notify(storageWarning); }, [storageWarning, notify]);
  function exportMetadata() {
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(store.getSnapshot(), null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "polymath-alfred-feature-history.json";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch { notify("Feature history could not be exported. Keep this tab open and copy important evidence and annotations manually."); }
  }
  return { state, update: store.update, storageWarning, exportMetadata };
}
