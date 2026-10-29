/*
 * One place that knows where a record lives, so a mention, a tool result and a
 * model-written link all land on the same route. Paths are duplicated by nobody
 * else in the chat surface; the routes themselves are the app's own.
 *
 * `recordPath` returns null for an unknown kind on purpose: a link to nowhere
 * is worse than a plain label, and the caller renders the label instead.
 */

export const RECORD_KINDS = [
  "task",
  "note",
  "document",
  "source",
  "project",
  "artifact",
  "run",
  "thread",
  "zettel",
  "card",
  "event",
  "contact",
  "company",
  "person",
  "organization",
  "opportunity",
  "space",
] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

/** The plural a UI label uses. Missing kinds fall back to the kind itself. */
const LABELS: Partial<Record<RecordKind, string>> = {
  task: "Task",
  note: "Note",
  document: "Document",
  source: "Source",
  project: "Project",
  artifact: "Artifact",
  run: "Run",
  thread: "Thread",
  zettel: "Zettel",
  card: "Card",
  event: "Event",
  contact: "Contact",
  company: "Company",
  person: "Person",
  organization: "Organization",
  opportunity: "Opportunity",
  space: "Space",
};

export const recordLabel = (kind: RecordKind): string => LABELS[kind] ?? kind;

export function isRecordKind(value: unknown): value is RecordKind {
  return typeof value === "string" && (RECORD_KINDS as readonly string[]).includes(value);
}

const PATHS: Record<RecordKind, (id: string) => string> = {
  task: () => "/work",
  note: () => "/polymath/notes",
  document: (id) => `/polymath/library/${id}`,
  source: () => "/polymath/sources",
  project: (id) => `/projects/${id}`,
  artifact: (id) => `/artifacts/${id}`,
  run: (id) => `/polymath/${id}`,
  thread: (id) => `/command-center/conversations/${id}`,
  zettel: () => "/polymath/knowledge/zettels",
  card: () => "/polymath/knowledge/cards",
  event: () => "/calendar",
  contact: () => "/command-center/relationships/contacts",
  company: () => "/command-center/relationships/companies",
  person: () => "/command-center/relationships/people",
  organization: () => "/command-center/relationships/companies",
  opportunity: () => "/command-center/opportunities",
  space: () => "/polymath",
};

/**
 * The route for a record. A kind whose surface is a collection (tasks, notes,
 * events) has no per-id page today, so it links to the collection rather than
 * inventing a detail route that 404s — the id still travels in the label.
 */
export function recordPath(kind: RecordKind, id: string): string | null {
  const build = PATHS[kind];
  return build ? build(id) : null;
}

/**
 * The in-app references a tool result can carry. Tools return their own shape
 * (`tasks`, `results`, `items`), so the kind is inferred from the key that
 * holds the list rather than from a field every tool would have to add — a
 * normalised `records` array on every payload would be tokens the model pays
 * for and never reads.
 */
export type RecordReference = { kind: RecordKind; id: string; title: string; subtitle?: string };

/** Which record kind a tool output's list key holds. */
const KEY_KINDS: Record<string, RecordKind> = {
  records: "task",
  tasks: "task",
  notes: "note",
  documents: "document",
  sources: "source",
  projects: "project",
  artifacts: "artifact",
  runs: "run",
  threads: "thread",
  zettels: "zettel",
  cards: "card",
  events: "event",
  contacts: "contact",
  companies: "company",
  people: "person",
  opportunities: "opportunity",
  links: "card",
};

export function asRecordReference(entry: unknown, fallbackKind?: RecordKind): RecordReference | null {
  if (entry === null || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const kind = record.kind ?? record.targetType ?? record.type ?? fallbackKind;
  const id = record.id ?? record.targetId;
  if (!isRecordKind(kind) || typeof id !== "string") return null;
  const title = record.title ?? record.label ?? record.name;
  if (typeof title !== "string" || title.length === 0) return null;
  // A due date reads as the useful second line on a task card; a status is a
  // weak substitute but better than an empty row.
  const subtitle = record.subtitle ?? record.summary ?? record.dueAt ?? record.status;
  return { kind, id, title, ...(typeof subtitle === "string" ? { subtitle } : {}) };
}

/** Every record reference in a tool output, deduped by kind+id, capped for the thread. */
export function collectRecords(output: unknown, limit = 6): RecordReference[] {
  if (output === null || typeof output !== "object") return [];
  const record = output as Record<string, unknown>;

  // `results` is the shape document search returns, and its entries carry
  // `documentId` rather than `id`, so the generic path below cannot read it.
  // A result with a documentId is a library document; one without (a web hit,
  // which has a url) is not a record and is left to the source list.
  if (Array.isArray(record.results)) {
    const seenDocuments = new Set<string>();
    const out: RecordReference[] = [];
    for (const entry of record.results) {
      if (entry === null || typeof entry !== "object") continue;
      const hit = entry as { documentId?: unknown; title?: unknown; text?: unknown };
      if (typeof hit.documentId !== "string" || typeof hit.title !== "string") continue;
      if (seenDocuments.has(hit.documentId)) continue;
      seenDocuments.add(hit.documentId);
      out.push({ kind: "document", id: hit.documentId, title: hit.title });
      if (out.length === limit) break;
    }
    if (out.length > 0) return out;
  }

  const holder = Object.entries(record).find(([key, value]) => KEY_KINDS[key] && Array.isArray(value));
  if (!holder) return [];
  const [key, list] = holder as [string, unknown[]];
  const kind = KEY_KINDS[key];
  const seen = new Set<string>();
  const out: RecordReference[] = [];
  for (const entry of list) {
    const ref = asRecordReference(entry, kind);
    if (!ref) continue;
    const id = `${ref.kind}:${ref.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(ref);
    if (out.length === limit) break;
  }
  return out;
}
