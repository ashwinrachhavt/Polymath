/*
 * An unsaved note draft lives in browser storage beside the workspace, keyed by
 * the same authenticated scope the workspace uses. It is a recovery copy, not a
 * checkpoint: saving the note deletes it, and restoring one never writes a
 * version. Scoping it matters — a draft hydrated under another owner's scope
 * would show that owner's text in this editor.
 */
export type WorkingDraft = { title: string; body: string; tags: string; at: string };

function key(scope: string, artifactId: string) {
  return `axiom-note-draft-v1:${scope}:${artifactId}`;
}

function storage() {
  try { return globalThis.localStorage ?? window.localStorage; } catch { return undefined; }
}

export function readDraft(scope: string, artifactId: string): WorkingDraft | undefined {
  try {
    const raw = storage()?.getItem(key(scope, artifactId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<WorkingDraft>;
    if (typeof parsed.title !== "string" || typeof parsed.body !== "string" || typeof parsed.tags !== "string") return undefined;
    return { title: parsed.title, body: parsed.body, tags: parsed.tags, at: typeof parsed.at === "string" ? parsed.at : "" };
  } catch { return undefined; }
}

export function writeDraft(scope: string, artifactId: string, draft: Omit<WorkingDraft, "at">) {
  try {
    storage()?.setItem(key(scope, artifactId), JSON.stringify({ ...draft, at: new Date().toISOString() }));
    return true;
  } catch { return false; }
}

export function clearDraft(scope: string, artifactId: string) {
  try { storage()?.removeItem(key(scope, artifactId)); } catch { /* a draft that cannot be removed is inert once cleared in memory */ }
}
