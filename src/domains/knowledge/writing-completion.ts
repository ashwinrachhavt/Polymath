import type { AuthContext } from "@/domains/identity/resolve";
import { generationProvider, type GenerationProvider } from "@/integrations/generation/provider";
import { providerEntry } from "@/integrations/providers/registry";
import { drizzleQuotaStore, withQuota, type QuotaStore } from "@/integrations/providers/quota";

/*
 * Inline autocomplete for prose: the next few words at the cursor, the way a
 * code editor completes a line. The model proposes; this module decides what
 * is shown - one short continuation, joined to the text exactly (mid-word or
 * new word), never a repeat of what is already on either side of the cursor,
 * and nothing at all when the reply is not a continuation.
 *
 * It rides the generation seam, so the provider chain and the quota ledger
 * are the ones every other model call uses: an exhausted free allowance stops
 * suggestions instead of moving to a paid route.
 */

/** How much of the note the model sees around the cursor. */
export const COMPLETION_BEFORE_CHARS = 2_000;
export const COMPLETION_AFTER_CHARS = 400;
const MAX_TOKENS = 48;
const MAX_WORDS = 24;
const MAX_CHARS = 180;
/** A suggestion that takes longer than this is no longer about what is being typed. */
const DEADLINE_MS = 4_000;

const SYSTEM = `You complete a writer's text at the cursor inside a notes editor, the way code autocomplete completes a line.

Rules:
- Start your reply with the last word before the cursor, exactly as written (finish it if it stops mid-word), then continue. If the text before the cursor ends with a space or a line break, just continue.
- Write at most one sentence and no more than 20 words. Stop earlier when the thought is complete.
- Match the writer's language, voice, tense and formatting. No headings, lists, quotes or markdown unless the text is already inside one.
- Never repeat text that is already before or after the cursor.
- Never answer, explain or address the writer. Do not invent facts, names, numbers or citations the note does not support; continue the writer's own line of thought.
- If there is no natural continuation, reply with nothing.

Reply with only the continuation text.`;

export function completionPrompt(input: { title?: string; before: string; after: string }): string {
  return [
    input.title?.trim() ? `Note title: ${input.title.trim()}` : null,
    `Text before the cursor:\n<before>${input.before}</before>`,
    `Text after the cursor:\n<after>${input.after}</after>`,
    "Continuation:",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const META_REPLY = /^(sure|here(?:'s| is)|i['’]m sorry|i cannot|i can['’]t|as an ai|continuation:)/i;
const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * Turn a raw model reply into the text to insert at the cursor, or "" when
 * there is nothing worth showing. `before` and `after` are the note text on
 * either side of the cursor.
 */
export function cleanCompletion(raw: string, before: string, after: string): string {
  let text = raw.replace(/\r/g, "");
  // A fenced or quoted reply is the continuation wrapped, not part of it.
  text = text.replace(/^\s*```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "");
  text = text.replace(/^\s*<\/?(?:before|after)>/i, "");
  if (META_REPLY.test(text.trim())) return "";
  // One line: a suggestion never starts a new block.
  text = text.replace(/^\n+/, "").split("\n")[0] ?? "";

  // Join the reply to the text exactly. `tail` is the word the cursor sits in
  // or just after; the model was asked to start by echoing it.
  const lead = text.trimStart();
  const tail = /([\p{L}\p{N}][\p{L}\p{N}'’-]*)$/u.exec(before)?.[1] ?? "";
  const afterOpener = before === "" || /[\s([{"“‘'/—–-]$/.test(before);
  if (tail && lead.toLowerCase().startsWith(tail.toLowerCase())) {
    // Echoed: what follows joins as written, whether it finishes the word
    // ("interes" + "ting") or starts the next one (" should be").
    text = lead.slice(tail.length);
  } else if (afterOpener) {
    // After a space, a line break or an opening mark the reply begins a word.
    text = lead;
  } else {
    // No echo. Drop a longer repeat of the text before the cursor if there is
    // one; otherwise the reply is the next word and needs its space.
    let overlap = 0;
    for (let size = Math.min(lead.length, before.length, 120); size >= 6; size--) {
      if (before.endsWith(lead.slice(0, size))) {
        overlap = size;
        break;
      }
    }
    if (overlap) text = lead.slice(overlap);
    else text = /^[\p{L}\p{N}]/u.test(lead) ? ` ${lead}` : lead;
  }

  // One sentence, a bounded number of words.
  const sentence = /^(.*?[.!?…]["')\]]?)(?:\s|$)/.exec(text);
  if (sentence && sentence[1].trim().split(/\s+/).length >= 2) text = sentence[1];
  const words = text.match(/\s*\S+/g) ?? [];
  if (words.length > MAX_WORDS) text = words.slice(0, MAX_WORDS).join("");
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS).replace(/\s+\S*$/, "");
  text = text.trimEnd();

  if (!HAS_WORD.test(text)) return "";
  // Already there: the text after the cursor says the same thing.
  const next = after.trimStart().toLowerCase();
  if (next && next.startsWith(text.trim().toLowerCase())) return "";
  return text;
}

export async function completeWriting(
  auth: Pick<AuthContext, "workspaceId">,
  input: { title?: string; before: string; after?: string },
  deps: { provider?: GenerationProvider; quotaStore?: QuotaStore; signal?: AbortSignal } = {},
): Promise<{ completion: string }> {
  const before = input.before.slice(-COMPLETION_BEFORE_CHARS);
  const after = (input.after ?? "").slice(0, COMPLETION_AFTER_CHARS);
  // Too little to continue from: no call, no spend.
  if (before.trim().length < 3) return { completion: "" };

  const provider = deps.provider ?? generationProvider(process.env);
  const prompt = completionPrompt({ title: input.title, before, after });
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const call = () =>
    provider.generate({
      system: SYSTEM,
      prompt,
      temperature: 0.2,
      maxTokens: MAX_TOKENS,
      signal: deps.signal ? AbortSignal.any([deadline, deps.signal]) : deadline,
    });

  const entry = providerEntry(provider.registryId);
  const metered = Boolean(entry?.quota && entry.enabled);
  const byTokens = entry?.quota?.unit === "tokens";
  const estimate = byTokens ? Math.ceil((SYSTEM.length + prompt.length) / 4) + MAX_TOKENS : 1;
  const reply =
    metered && entry
      ? await withQuota(deps.quotaStore ?? drizzleQuotaStore(), entry, auth.workspaceId, estimate, call, (result) =>
          byTokens
            ? (result.usage?.inputTokens ?? estimate - MAX_TOKENS) + (result.usage?.outputTokens ?? MAX_TOKENS)
            : 1,
        )
      : await call();
  return { completion: cleanCompletion(reply.text, before, after) };
}
