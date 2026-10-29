/*
 * ASH-306: conversational navigation. The Supervisor thread is the primary
 * shell; asking for a surface in words must not cost a model run. This parser
 * is deterministic on purpose: navigation is a product guarantee, not a
 * generation, so every recognized phrase resolves to one named destination or
 * panel, and everything unrecognized falls through to the model path.
 *
 * Vocabulary is deliberately small and exact-match-ish; the model stays free
 * to navigate too, through the same part types, when it is involved.
 */

export type SurfaceKind = "tasks" | "notes" | "calendar" | "runs" | "decisions" | "library";

export type NavigationIntent =
  | { kind: "surface"; surface: SurfaceKind }
  | { kind: "open_note"; query: string };

const SURFACE_PHRASES: Array<[RegExp, SurfaceKind]> = [
  [/\b(open|show( me)?|see|view|list)( my| the)? (open )?tasks?\b/i, "tasks"],
  [/\b(open|show( me)?|see|view)( my| the)? notes?\b/i, "notes"],
  [/\b(open|show( me)?|see|view)( my| the)? (calendar|schedule|week|agenda)\b/i, "calendar"],
  [/\b(open|show( me)?|see|view)( my| the)? (agent )?runs?\b/i, "runs"],
  [/\b(open|show( me)?|see|view)( my| the)? (decisions|reviews?|approvals?|(reviews? )?queue)\b/i, "decisions"],
  [/\b(open|show( me)?|see|view)( my| the)? (library|documents?|reading)\b/i, "library"],
];

const OPEN_NOTE = /^(?:open|find|show( me)?|read)(?: the)? note(?: about| on| titled)?\s+(.+)$/i;

/** The recognized navigation intent of one message, or null for the model path. */
export function parseNavigationIntent(message: string): NavigationIntent | null {
  const text = message.trim().replace(/[.?!]+$/, "");
  if (!text) return null;
  const note = OPEN_NOTE.exec(text);
  if (note) {
    // A named-note request with too little to search on is not navigation.
    const query = note[2].trim();
    return query.length >= 2 ? { kind: "open_note", query } : null;
  }
  for (const [pattern, surface] of SURFACE_PHRASES) {
    if (pattern.test(text)) return { kind: "surface", surface };
  }
  return null;
}

/** Where the surface lives today; a card in the thread links out honestly. */
export const SURFACE_HREF: Record<SurfaceKind, string> = {
  tasks: "/neuralflow/work",
  notes: "/polymath/notes",
  calendar: "/command-center/day",
  runs: "/activity",
  decisions: "/",
  library: "/polymath/library",
};

export const SURFACE_LABEL: Record<SurfaceKind, string> = {
  tasks: "Tasks",
  notes: "Notes",
  calendar: "Calendar",
  runs: "Runs",
  decisions: "Decisions",
  library: "Library",
};
