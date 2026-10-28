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
 * message that merely quotes JSON never trips the strip.
 */

export type MentionEntity = RecordReference & {
  kind: "person" | "company";
};

const CONTEXT_OPEN = "[context:mention id=";
const CONTEXT_CLOSE = "]\n";

/** The `@Name` mention markers a draft carries for the given entities. */
export function mentionedEntities(entities: MentionEntity[], text: string): MentionEntity[] {
  return entities.filter((entity) => text.includes(`@${entity.title}`));
}

/**
 * Serialize fetched context into the hidden block appended to the model's
 * copy of the message. One block per entity, keyed by its id so the server
 * side can attribute context to a mention.
 */
export function serializeMentionContext(entries: Array<{ entity: MentionEntity; context: Record<string, unknown> }>): string {
  if (entries.length === 0) return "";
  return (
    "\n" +
    entries
      .map(({ entity, context }) => `${CONTEXT_OPEN}${entity.id} kind=${entity.kind} name=${entity.title}${CONTEXT_CLOSE}${JSON.stringify(context)}`)
      .join("\n")
  );
}

/**
 * The message minus the context blocks. Applied at every render path that
 * reads message text, so the JSON the model sees never reaches the screen.
 * The block's JSON is serialized on one line (compact stringify), so the
 * match runs to that line's final brace and cannot swallow later prose.
 */
export function stripMentionContext(text: string): string {
  return text.replace(/\n?\[context:mention id=[^\]]*?\]\n\{.*\}/g, "");
}

/** True when the text carries at least one context block. */
export function hasMentionContext(text: string): boolean {
  return text.includes(CONTEXT_OPEN);
}
