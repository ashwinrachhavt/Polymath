import type { RecordReference } from "./composer-plus";

/*
 * The @-mention context contract. Picking a person or company inserts
 * `@Name` into the draft and remembers the entity; at submit the remembered
 * entities whose name still appears as `@Name` are fetched and serialized as
 * a context block appended to the message the model reads. The visible text
 * keeps only what the person typed — the block is stripped at render time by
 * stripMentionContext, so the transcript never shows JSON.
 *
 * The token format is line-anchored and ends at a closing brace, so a
 * message that merely quotes JSON never trips the strip. The header carries
 * only the entity's id (a UUID cannot contain `]` or a newline), so a title
 * with either character cannot break the strip; the display name and kind
 * ride inside the JSON payload instead.
 *
 * Old-format blocks (name and kind in the header) still strip cleanly unless
 * the title itself contained `]`; those exist only in already-stored messages.
 */

export type MentionEntity = RecordReference & {
  kind: "person" | "company";
};

const CONTEXT_OPEN = "[context:mention id=";
const CONTEXT_CLOSE = "]\n";

/** One string field longer than this is cut to it, ellipsis marked. */
export const MAX_CONTEXT_FIELD_CHARS = 512;
/** A serialized block larger than this after field clamping is dropped whole. */
export const MAX_CONTEXT_BLOCK_CHARS = 2000;
/** Total characters of context blocks one message may carry. */
export const MAX_TOTAL_CONTEXT_CHARS = 4000;

const ELLIPSIS = "…";

/** The string shortened to `max` characters, ellipsis-marked when cut. */
export function truncateForContext(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}${ELLIPSIS}`;
}

/**
 * Long prose fields (notes, observation bodies) dominate the context; clamp
 * every string value anywhere in the object so one field cannot blow the
 * budget. JSON validity is preserved — truncation happens per string, never
 * on the serialized blob, so the strip's close-brace match stays sound.
 */
function clampContext<T>(value: T): T {
  if (typeof value === "string") return truncateForContext(value, MAX_CONTEXT_FIELD_CHARS) as T;
  if (Array.isArray(value)) return value.map(clampContext) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clampContext(item)]),
    ) as T;
  }
  return value;
}

/** The `@Name` mention markers a draft carries for the given entities. */
export function mentionedEntities(entities: MentionEntity[], text: string): MentionEntity[] {
  // Boundary-aware: the mention must open at start/whitespace and close at
  // end/whitespace/punctuation, so "@Ann" no longer matches inside "@Ann
  // Smith" or "email@Ann". A close followed by another capitalized word
  // means the typed token continues past this title ("@Ann Smith" names Ann
  // Smith, not Ann), so a bare "@Ann" does not fire there; ordinary
  // lowercase prose after the name still matches.
  const matches = (title: string) =>
    new RegExp(`(^|\\s)@${escapeRegExp(title)}(?=$|[\\s,.:;!?])(?!\\s+[A-Z])`).test(text);
  return entities.filter((entity) => {
    if (!matches(entity.title)) return false;
    return !entities.some(
      (other) =>
        other !== entity &&
        other.title.length > entity.title.length &&
        other.title.startsWith(`${entity.title} `) &&
        matches(other.title),
    );
  });
}

/** Regex-escape a string for literal matching. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Serialize fetched context into the hidden block appended to the model's
 * copy of the message. One block per entity, keyed by its id so the server
 * side can attribute context to a mention. The entity's name and kind ride
 * inside the JSON payload, not the header, so any title survives the strip.
 *
 * Budget: strings are clamped per field; a block still over
 * MAX_CONTEXT_BLOCK_CHARS is dropped whole (cutting the JSON would break the
 * strip's close-brace anchor), and once MAX_TOTAL_CONTEXT_CHARS is reached
 * the remaining entities are skipped in call order.
 */
export function serializeMentionContext(entries: Array<{ entity: MentionEntity; context: Record<string, unknown> }>): string {
  if (entries.length === 0) return "";
  const blocks: string[] = [];
  let total = 0;
  for (const { entity, context } of entries) {
    const payload = JSON.stringify({
      kind: entity.kind,
      name: truncateForContext(entity.title, MAX_CONTEXT_FIELD_CHARS),
      ...clampContext(context),
    });
    if (payload.length > MAX_CONTEXT_BLOCK_CHARS) continue;
    if (total + payload.length > MAX_TOTAL_CONTEXT_CHARS) break;
    total += payload.length;
    blocks.push(`${CONTEXT_OPEN}${entity.id}${CONTEXT_CLOSE}${payload}`);
  }
  if (blocks.length === 0) return "";
  return `\n${blocks.join("\n")}`;
}

/**
 * The message minus the context blocks. Applied at every render path that
 * reads message text, so the JSON the model sees never reaches the screen.
 * The strip is anchored on the id (a UUID cannot contain `]` or a newline),
 * and the block's JSON is serialized on one line (compact stringify), so the
 * match runs to that line's final brace and cannot swallow later prose.
 */
export function stripMentionContext(text: string): string {
  return text.replace(/\n?\[context:mention id=[^\]]*?\]\n\{.*\}/g, "");
}

/** True when the text carries at least one context block. */
export function hasMentionContext(text: string): boolean {
  return text.includes(CONTEXT_OPEN);
}

const MENTION_BLOCK_RE = /\n?\[context:mention id=[^\]]*?\]\n\{.*\}/g;

/**
 * The message fitted to `cap` characters: the typed text is never touched;
 * context blocks are dropped whole (from the end, in order) until it fits.
 * Whole blocks, because cutting the serialized JSON would break the strip's
 * close-brace anchor and leak JSON to the transcript. When the typed text
 * alone already reaches the cap no context rides at all — and the typed text
 * itself is still returned as-is: losing it is the one failure this contract
 * forbids.
 */
export function fitMentionContext(message: string, cap: number): string {
  if (message.length <= cap) return message;
  const typed = stripMentionContext(message);
  if (typed.length >= cap) return typed;
  let fitted = typed;
  for (const block of message.match(MENTION_BLOCK_RE) ?? []) {
    if (fitted.length + block.length > cap) break;
    fitted += block;
  }
  return fitted;
}

/**
 * The one mention-resolution sequence every submit path repeats: keep the
 * entities the text still names, fetch each one's context, and append the
 * serialized blocks. The fetcher is injected (a server action) so this
 * client module stays free of server imports.
 */
export async function resolveMentionPayload(
  mentions: MentionEntity[],
  text: string,
  fetchContext: (input: { kind: MentionEntity["kind"]; id: string }) => Promise<Record<string, unknown> | null>,
): Promise<string> {
  const named = mentionedEntities(mentions, text);
  if (named.length === 0) return text;
  const contexts = await Promise.all(
    named.map(async (entity) => ({ entity, context: (await fetchContext({ kind: entity.kind, id: entity.id })) ?? null })),
  );
  const resolved = contexts.filter(
    (entry): entry is { entity: MentionEntity; context: Record<string, unknown> } => entry.context !== null,
  );
  if (resolved.length === 0) return text;
  return `${text}${serializeMentionContext(resolved)}`;
}
