import type { QuizEvidence } from "./schema";

/*
 * Read-first quizzes: before the questions about it, the learner reads a
 * short passage of the source. A passage is cut from the extraction text
 * around the located quotes of one or more questions, so it always holds the
 * text those questions are graded against.
 *
 * Extraction text cannot be trusted to have paragraphs (a web article often
 * arrives as one 14,000-character line), so a passage widens from its quotes
 * to sentence ends, and treats a blank line as a break only where one
 * exists. It is cut, never rewritten: the body is the source's own text with
 * long runs of blank lines collapsed.
 */

export type QuizPassage = {
  /** `${extractionId}:${start offset}`: the same quiz always yields the same ids. */
  id: string;
  sourceTitle: string;
  body: string;
  /** In ordinal order. */
  questionIds: string[];
};

type PassageQuestion = { id: string; ordinal: number; evidence: QuizEvidence };
type PassageSource = { title: string; text: string };
type Span = { start: number; end: number };

/** Below this a passage keeps widening by whole sentences where the text allows. */
const MIN_CHARS = 400;
/** Above this a passage is split; only a single quote longer than it may pass. */
const MAX_CHARS = 1200;
/** How far a passage cut falls back to look for a space when no sentence end fits. */
const WORD_REACH = 40;

/**
 * The quiz's passages in reading order: sources in the order of their first
 * question, passages within a source by position. A question whose evidence
 * cannot be placed in its source text gets no passage.
 */
export function buildQuizPassages(
  questions: PassageQuestion[],
  sources: Map<string, PassageSource>,
  fallbackExtractionId: string,
): QuizPassage[] {
  const bySource = new Map<string, Array<PassageQuestion & Span>>();
  for (const question of questions) {
    const extractionId = question.evidence.source?.extractionId ?? fallbackExtractionId;
    const text = sources.get(extractionId)?.text;
    const { startOffset: start, endOffset: end } = question.evidence;
    if (text === undefined || !(0 <= start && start < end && end <= text.length)) continue;
    const placed = bySource.get(extractionId) ?? [];
    placed.push({ ...question, start, end });
    bySource.set(extractionId, placed);
  }

  const firstOrdinal = (placed: PassageQuestion[]) => Math.min(...placed.map((q) => q.ordinal));
  const ordered = [...bySource].sort(([, a], [, b]) => firstOrdinal(a) - firstOrdinal(b));

  return ordered.flatMap(([extractionId, placed]) => {
    const { title, text } = sources.get(extractionId)!;
    const groups = groupNearby(text, placed);
    let floor = 0;
    return groups.map((group, n) => {
      const ceiling = groups[n + 1]?.span.start ?? text.length;
      const span = widen(text, group.span, floor, ceiling);
      floor = Math.max(floor, span.end);
      return {
        id: `${extractionId}:${span.start}`,
        sourceTitle: title,
        body: text
          .slice(span.start, span.end)
          .replace(/\n(?:[ \t]*\n){2,}/g, "\n\n")
          .trim(),
        questionIds: [...group.questions].sort((a, b) => a.ordinal - b.ordinal).map((q) => q.id),
      };
    });
  });
}

/** Greedy by position: a question joins the open group while their sentences still fit the cap. */
function groupNearby(text: string, placed: Array<PassageQuestion & Span>) {
  const byPosition = [...placed].sort((a, b) => a.start - b.start || a.end - b.end || a.ordinal - b.ordinal);
  const groups: Array<{ span: Span; questions: PassageQuestion[] }> = [];
  for (const question of byPosition) {
    const open = groups.at(-1);
    const joined = open && { start: open.span.start, end: Math.max(open.span.end, question.end) };
    if (open && joined && snapToSentences(text, joined, MAX_CHARS)) {
      open.span = joined;
      open.questions.push(question);
    } else {
      groups.push({ span: { start: question.start, end: question.end }, questions: [question] });
    }
  }
  return groups;
}

/**
 * The quotes' span out to whole sentences, then sentence by sentence (end
 * first, then start) until it reaches MIN_CHARS, without passing MAX_CHARS
 * or crossing into a neighbouring passage.
 */
function widen(text: string, quotes: Span, floor: number, ceiling: number): Span {
  const quoteLength = quotes.end - quotes.start;
  const limit = quoteLength > MAX_CHARS ? quoteLength + MIN_CHARS : MAX_CHARS;
  const span = snapToSentences(text, quotes, limit) ?? snapToWords(text, quotes);
  while (span.end - span.start < MIN_CHARS) {
    const end =
      span.end < Math.min(ceiling, text.length) ? sentenceEndFrom(text, span.end + 1, span.start + MAX_CHARS) : null;
    const grewEnd = end !== null && end <= ceiling;
    if (grewEnd) span.end = end;
    if (span.end - span.start >= MIN_CHARS) break;
    const start = span.start > floor ? sentenceStartFrom(text, span.start - 1, span.end - MAX_CHARS) : null;
    const grewStart = start !== null && start >= floor;
    if (grewStart) span.start = start;
    if (!grewEnd && !grewStart) break;
  }
  return span;
}

function snapToSentences(text: string, span: Span, limit: number): Span | null {
  const start = sentenceStartFrom(text, span.start, span.end - limit);
  const end = sentenceEndFrom(text, span.end, span.start + limit);
  if (start === null || end === null || end - start > limit) return null;
  return { start, end };
}

/** The fallback for text with no sentence end in reach: out to the nearest spaces, or the quote as given. */
function snapToWords(text: string, span: Span): Span {
  let start = span.start;
  while (start > 0 && start > span.start - WORD_REACH && !/\s/.test(text[start - 1])) start--;
  if (start > 0 && !/\s/.test(text[start - 1])) start = span.start;
  let end = span.end;
  while (end < text.length && end < span.end + WORD_REACH && !/\s/.test(text[end])) end++;
  if (end < text.length && !/\s/.test(text[end])) end = span.end;
  return { start, end };
}

/** The nearest sentence start at or before `from`, looking no further back than `floor`. */
function sentenceStartFrom(text: string, from: number, floor: number): number | null {
  for (let i = Math.min(from, text.length - 1); i >= Math.max(0, floor); i--) {
    if (isSentenceStart(text, i)) return i;
  }
  return null;
}

/** The nearest sentence end at or after `from`, looking no further ahead than `ceiling`. */
function sentenceEndFrom(text: string, from: number, ceiling: number): number | null {
  for (let i = Math.max(from, 1); i <= Math.min(ceiling, text.length); i++) {
    if (isSentenceEnd(text, i)) return i;
  }
  return null;
}

const SPACE = /\s/;
const STOP = /[.!?。！？]/;
const CLOSER = /["'”’)\]]/;

/** A non-space character that is the text's first, or follows a sentence stop or a blank line. */
function isSentenceStart(text: string, at: number): boolean {
  if (at === 0) return !SPACE.test(text[0]);
  if (SPACE.test(text[at]) || !SPACE.test(text[at - 1])) return false;
  let last = at - 1;
  while (last >= 0 && SPACE.test(text[last])) last--;
  if (last < 0) return true;
  if (/\n[ \t]*\n/.test(text.slice(last + 1, at))) return true;
  while (last >= 0 && CLOSER.test(text[last])) last--;
  return last >= 0 && STOP.test(text[last]);
}

/** The position just past a sentence: the next non-space character starts one, or the text ends. */
function isSentenceEnd(text: string, at: number): boolean {
  if (at === text.length) return true;
  if (SPACE.test(text[at - 1]) || !SPACE.test(text[at])) return false;
  let next = at;
  while (next < text.length && SPACE.test(text[next])) next++;
  return next === text.length || isSentenceStart(text, next);
}
