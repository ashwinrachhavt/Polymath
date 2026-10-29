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
  /** §14.4: server hydration found a newer saved version than our base. */
  conflict: { serverUpdatedAt: number } | null;
  setDraft: (draft: string) => void;
  setTopic: (topic: string) => void;
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
        setTopic: (topic) => set({ topic }),
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
        storage: createJSONStorage(() => localStorage),
        // Only the draft + its clock persist; conflicts are recomputed on hydrate.
        partialize: (s) => ({ draft: s.draft, draftUpdatedAt: s.draftUpdatedAt, topic: s.topic }),
      },
    ),
  );
}

export type SittingStore = ReturnType<typeof createSittingStore>;
