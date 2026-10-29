import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/*
 * Sitting draft persistence (plan §7 ownership table): localStorage owns
 * UNSAVED writing only; the server owns accepted content, versions and stage
 * outcomes. Keys are scoped by workspace + sitting so two sittings (or two
 * workspaces) never share a draft. The merge is updatedAt-wins and hydration
 * never silently overwrites newer server state: reconcileWithServer() is
 * called after server hydration, and a newer server version surfaces as a
 * conflict the user resolves (§14.4: keep mine / take server), never a
 * silent clobber. Two tabs on the same sitting are last-write-wins on the
 * draft, which §7 accepts.
 */

export const sittingStorageKey = (workspaceId: string, sittingId: string) =>
  `polymath-sitting:${workspaceId}:${sittingId}`;

export type SittingDraftState = {
  draft: string;
  /** Epoch ms of the last local edit; the merge clock. */
  draftUpdatedAt: number;
  topic: string;
  /** Server-side card this draft belongs to, once saved (§14.11 idea flow). */
  savedArtifactId: string | null;
  savedVersion: number | null;
  /** §14.4: server hydration found a newer saved version than our base. */
  conflict: { serverUpdatedAt: number } | null;
  setDraft: (draft: string) => void;
  setTopic: (topic: string) => void;
  setSavedCard: (artifactId: string, version: number) => void;
  /** Server hydrate: adopt server content only when it is strictly newer AND no local unsaved edits exist. */
  reconcileWithServer: (input: { content: string; updatedAt: number }) => "adopted" | "kept-local" | "conflict";
  resolveConflict: (choice: "keep-mine" | "take-server", serverContent?: string) => void;
};

export function createSittingStore(workspaceId: string, sittingId: string) {
  return create<SittingDraftState>()(
    persist(
      (set, get) => ({
        draft: "",
        draftUpdatedAt: 0,
        topic: "",
        conflict: null,
        setDraft: (draft) => set({ draft, draftUpdatedAt: Date.now() }),
        savedArtifactId: null,
        savedVersion: null,
        setTopic: (topic) => set({ topic }),
        setSavedCard: (artifactId, version) => set({ savedArtifactId: artifactId, savedVersion: version }),
        reconcileWithServer: ({ content, updatedAt }) => {
          const { draft, draftUpdatedAt } = get();
          if (updatedAt <= draftUpdatedAt) return "kept-local";
          if (draftUpdatedAt === 0 || draft === content) {
            set({ draft: content, draftUpdatedAt: updatedAt, conflict: null });
            return "adopted";
          }
          // Both sides moved: surface the conflict (§14.4), keep local on top.
          set({ conflict: { serverUpdatedAt: updatedAt } });
          return "conflict";
        },
        resolveConflict: (choice, serverContent) => {
          if (choice === "take-server" && serverContent !== undefined) {
            set({ draft: serverContent, draftUpdatedAt: get().conflict?.serverUpdatedAt ?? Date.now(), conflict: null });
          } else {
            set({ conflict: null });
          }
        },
      }),
      {
        name: sittingStorageKey(workspaceId, sittingId),
        // localStorage is best-effort recovery for unsaved text (§7), not a
        // record: a debounced write keeps the synchronous serialize off the
        // keystroke path. 500ms is well under the 1.2s pause, so a tab close
        // mid-pause still recovers the draft.
        storage: createJSONStorage(() => debouncedStorage(() => localStorage, 500)),
        // Only the draft + its clock persist; conflicts are recomputed on hydrate.
        partialize: (s) => ({
          draft: s.draft,
          draftUpdatedAt: s.draftUpdatedAt,
          topic: s.topic,
          savedArtifactId: s.savedArtifactId,
          savedVersion: s.savedVersion,
        }),
      },
    ),
  );
}

/** Wraps a StateStorage so setItem lands at most once per `ms` window. */
function debouncedStorage(getStorage: () => Storage, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingValue: string | null = null;
  return {
    getItem: (name: string): string | null => getStorage().getItem(name),
    setItem: (name: string, value: string): void => {
      pendingValue = value;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (pendingValue !== null) getStorage().setItem(name, pendingValue);
        pendingValue = null;
      }, ms);
    },
    removeItem: (name: string): void => {
      if (timer) { clearTimeout(timer); timer = null; pendingValue = null; }
      getStorage().removeItem(name);
    },
  };
}
export type SittingStore = ReturnType<typeof createSittingStore>;
