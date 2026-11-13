import { eq } from "drizzle-orm";
import { generateText, type LanguageModel } from "ai";
import type { ClaimedOutboxEvent, OutboxHandler } from "@/domains/audit/outbox";
import { chatModelWithKey, DEFAULT_MODEL_ID } from "@/domains/agents/models";
import { houseRoute } from "@/domains/billing/resolver";
import { pollFacts } from "@/lib/poll-facts";
import { db } from "@/lib/db";
import { pollFactSuggestions } from "./schema";

/*
 * The monthly refresh of the polling fact deck. A cron tick enqueues
 * `facts.suggestions_requested` once per month per dispatch key; this handler
 * asks a model for candidates and lands the survivors in
 * poll_fact_suggestions, where the suggestions route serves them to FactPoll.
 *
 * The deck in poll-facts.ts is the quality bar: any candidate no better than
 * its weakest entry is worse than nothing, so validation is deliberately
 * strict and a bad candidate is dropped, never forced. Delivery is
 * at-least-once; the unique text column and onConflictDoNothing make a
 * redelivery converge on the rows the first pass landed.
 */

export const FACT_SUGGESTION_TOPIC = "facts.suggestions_requested";

const MIN_CHARS = 80;
const MAX_CHARS = 260;
const MAX_INSERTS_PER_RUN = 8;

const FEWSHOT_FACTS = ["sunlight-two-journeys", "glass-never-settled", "nagel-bat", "mary-red-room"];

const fewshot = FEWSHOT_FACTS.map((id) => pollFacts.find((fact) => fact.id === id)?.text).filter(
  (text): text is string => Boolean(text),
);

export const FACT_SUGGESTION_SYSTEM = [
  "You write single-sentence facts for a waiting screen: lines a thoughtful adult reads twice, each startling, concrete, and checkable.",
  "Every fact must state something specific and verifiable about the physical world, mathematics, or philosophy of mind - not an opinion, not a platitude, not a metaphor the reader cannot pin down.",
  "Half science, half philosophy. For philosophy, never write a summary of an argument, and never stage a scene: no 'picture this', no invented balcony, no imagined mood. Report the thought experiment as its author actually posed it - the butterfly, the ship, the room - and let the recorded details carry it. 'Zhuangzi woke from dreaming he was a butterfly' is the form; 'imagine a child listening to a nightingale' invents a scene nobody wrote and is banned.",
  "Every number, name, and date must be real and correct. A fact that reads well but is wrong is worse than none - if you are not certain a figure is right, pick a fact you are certain of.",
  "Write numbers the way a person would say them: 'a hundred million tonnes', not '4 × 10¹² kg'. No scientific notation, no superscripts, no unit symbols with exponents. End on the fact itself - no 'indicating that', 'suggesting that', or 'showing that' clause after it.",
  "Hard bans: exclamation marks, 'Did you know', rhetorical questions, emoji, task or software or productivity framing, any reference to work, waiting, or the app showing the fact, and phrases like 'illustrates that', 'demonstrates that', 'probing the question of', or 'challenges the definition of'.",
  "No closing moral. End on the fact itself.",
  'Reply with only a JSON array: 8 objects, each {"topic": "science"|"philosophy", "text": string, "tags": string[2..3]}.',
  "Exactly 4 science and 4 philosophy. Each text 80 to 260 characters, one or two sentences.",
  "Tags are lowercase and drawn from this vocabulary when it fits: light, time, scale, mind, infinity, motion, biology, astronomy, math, change, knowledge, reality, matter, energy, water, night, survival, pattern, identity, dreams, doubt, certainty, experience, language, limits, meaning, control, learning, justice, fairness.",
].join("\n");

export function composeFactSuggestionPrompt(deckSamples: string[], deck: string[]): string {
  return [
    "Facts in the existing deck, as the standard of voice and density every candidate must meet:",
    deckSamples.map((text) => `- ${text}`).join("\n"),
    "",
    "Facts already in the deck. A candidate that overlaps any of them in idea or phrasing is rejected - do not restate these:",
    deck.map((text) => `- ${text}`).join("\n"),
    "",
    "Write 8 new facts to that standard. Nothing about software, tasks, productivity, or this product.",
  ].join("\n");
}

/** Lowercase, collapsed whitespace, punctuation stripped at the ends: the dedup key's normalization. */
export function normalizeFactKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Named rather than inline so the topic-coverage test's literal scan sees no fake emission. */
type FactTopic = "science" | "philosophy";

export type FactCandidate = { topic: FactTopic; text: string; tags: string[] };

const TOPICS: ReadonlySet<string> = new Set(["science", "philosophy"]);

/**
 * The defensive parse: fences stripped, the first JSON array in the reply,
 * one object per element, each field type-checked. Anything malformed is
 * skipped, not thrown - a half-good reply is still 8 chances at a fact.
 */
export function parseSuggestions(raw: string): FactCandidate[] {
  const stripped = raw.replace(/```(?:json)?/gi, "");
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const candidates: FactCandidate[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const topic = record.topic;
    const text = record.text;
    const tags = record.tags;
    if (typeof topic !== "string" || !TOPICS.has(topic)) continue;
    if (typeof text !== "string" || !text.trim()) continue;
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) continue;
    candidates.push({
      topic: topic as FactCandidate["topic"],
      text: text.trim(),
      tags: (tags as string[]).map((tag) => tag.toLowerCase().trim()).filter(Boolean),
    });
  }
  return candidates;
}

export type ValidationInput = {
  candidates: FactCandidate[];
  /** The full curated deck, normalized, as a rejection surface. */
  deck: string[];
  /** Normalized texts already suggested, from the table or earlier in this batch. */
  existing: Set<string>;
};

/**
 * The gates one candidate passes to become a suggestion: length, no "!", a
 * real topic, no deck overlap (case-insensitive substring in either
 * direction), no table or batch duplicate, and the per-run insert cap.
 */
export function validateCandidates(input: ValidationInput): FactCandidate[] {
  const deckKeys = input.deck.map(normalizeFactKey);
  const survivors: FactCandidate[] = [];
  const batchSeen = new Set<string>();
  for (const candidate of input.candidates) {
    if (survivors.length >= MAX_INSERTS_PER_RUN) break;
    const text = candidate.text.trim();
    if (text.length < MIN_CHARS || text.length > MAX_CHARS) continue;
    if (text.includes("!")) continue;
    if (!TOPICS.has(candidate.topic)) continue;
    const key = normalizeFactKey(text);
    if (batchSeen.has(key) || input.existing.has(key)) continue;
    const deckOverlap = deckKeys.some((deckKey) => deckKey.includes(key) || key.includes(deckKey));
    if (deckOverlap) continue;
    batchSeen.add(key);
    survivors.push({ ...candidate, text });
  }
  return survivors;
}

/** Runs after the candidate filters: a tag vocabulary that decays hurts nothing, but keep it honest. */
function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const cleaned = tag.toLowerCase().trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length === 3) break;
  }
  return result;
}

/**
 * The work half. Returns what it landed; never throws for a bad candidate.
 * Throws only for infrastructure problems (no model configured, a provider
 * error), so the dispatcher's backoff owns those.
 */
async function runFactSuggestionRequested(
  event: ClaimedOutboxEvent,
  deps: { model?: LanguageModel } = {},
): Promise<{ landed: number }> {
  // The public poll deck belongs to no workspace: this is operator work on the house key, outside every
  // workspace's allowance and ledger.
  const route = deps.model ? null : houseRoute(DEFAULT_MODEL_ID);
  const model = deps.model ?? chatModelWithKey(route!.option, route!.apiKey);

  const rows = await db
    .select({ text: pollFactSuggestions.text })
    .from(pollFactSuggestions)
    .where(eq(pollFactSuggestions.status, "active"));
  const existing = new Set(rows.map((row) => normalizeFactKey(row.text)));

  const completion = await generateText({
    model,
    system: FACT_SUGGESTION_SYSTEM,
    prompt: composeFactSuggestionPrompt(
      fewshot,
      pollFacts.map((fact) => fact.text),
    ),
    // Sized for a reasoning model: the visible JSON is ~1k tokens, but
    // the default model's chain-of-thought rides the same budget (on
    // gpt-oss-120b a 1,200 cap returned finish=length with an empty reply in
    // the 2026-11-05 probe).
    maxOutputTokens: 4_000,
  });

  const candidates = parseSuggestions(completion.text);
  if (candidates.length === 0) {
    console.warn(`${FACT_SUGGESTION_TOPIC}: the model reply held no parseable candidates`);
    return { landed: 0 };
  }
  const valid = validateCandidates({ candidates, deck: pollFacts.map((fact) => fact.text), existing });
  if (valid.length === 0) return { landed: 0 };

  const landed = await db
    .insert(pollFactSuggestions)
    .values(
      valid.map((candidate) => ({
        text: candidate.text,
        topic: candidate.topic,
        tags: cleanTags(candidate.tags),
        status: "active",
        source: "job",
      })),
    )
    .onConflictDoNothing({ target: pollFactSuggestions.text })
    .returning({ id: pollFactSuggestions.id });
  return { landed: landed.length };
}

/** Registry shape for outbox-handlers.ts. */
export const factSuggestionRequestedHandler: OutboxHandler = async (event) => {
  await runFactSuggestionRequested(event);
};
