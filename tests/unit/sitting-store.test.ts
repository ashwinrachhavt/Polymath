// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createSittingStore, sittingStorageKey } from "@/components/polymath/zettels/sitting-store";

/*
 * §7 ownership + §14.4 conflict: localStorage holds unsaved writing only,
 * keys are scoped by workspace+sitting, server hydrate adopts only strictly
 * newer content with no local edits, and a both-moved case surfaces a
 * conflict the user resolves - never a silent overwrite.
 */
describe("sitting draft store", () => {
  it("scopes keys by workspace and sitting", () => {
    expect(sittingStorageKey("w1", "s1")).toBe("polymath-sitting:w1:s1");
    expect(sittingStorageKey("w1", "s1")).not.toBe(sittingStorageKey("w1", "s2"));
    expect(sittingStorageKey("w1", "s1")).not.toBe(sittingStorageKey("w2", "s1"));
  });

  it("adopts server content when there are no local edits", () => {
    const store = createSittingStore("w", `s-${Date.now()}-a`);
    expect(store.getState().reconcileWithServer({ content: "server text", updatedAt: 1000 })).toBe("adopted");
    expect(store.getState().draft).toBe("server text");
  });

  it("keeps local when local is newer than the server hydrate", () => {
    const store = createSittingStore("w", `s-${Date.now()}-b`);
    store.getState().setDraft("my draft");
    const localAt = store.getState().draftUpdatedAt;
    expect(store.getState().reconcileWithServer({ content: "older server", updatedAt: localAt - 1000 })).toBe("kept-local");
    expect(store.getState().draft).toBe("my draft");
  });

  it("surfaces a conflict when both sides moved, and resolves both ways (§14.4)", () => {
    const store = createSittingStore("w", `s-${Date.now()}-c`);
    store.getState().setDraft("local edits");
    const future = Date.now() + 10_000;
    expect(store.getState().reconcileWithServer({ content: "server newer", updatedAt: future })).toBe("conflict");
    expect(store.getState().draft).toBe("local edits"); // local stays on top
    expect(store.getState().conflict?.serverUpdatedAt).toBe(future);
    store.getState().resolveConflict("keep-mine");
    expect(store.getState().conflict).toBeNull();
    expect(store.getState().draft).toBe("local edits");
    // And take-server:
    store.getState().setDraft("local edits 2");
    store.getState().reconcileWithServer({ content: "server newer 2", updatedAt: future + 1 });
    store.getState().resolveConflict("take-server", "server newer 2");
    expect(store.getState().draft).toBe("server newer 2");
    expect(store.getState().conflict).toBeNull();
  });

  it("persists the draft under the scoped key", async () => {
    const key = sittingStorageKey("w", `s-${Date.now()}-d`);
    const store = createSittingStore("w", key.slice("polymath-sitting:w:".length));
    store.getState().setDraft("persisted");
    // The storage wrapper debounces writes (500ms) to keep the synchronous
    // serialize off the keystroke path; the flush is waited out here.
    await new Promise((r) => setTimeout(r, 600));
    const raw = localStorage.getItem(key);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).state.draft).toBe("persisted");
  });
});
