import type { ChallengeStep, LineCheck, StepCheck, TermCheck } from "./challenge-content";

/*
 * Pure grading for practice challenges: no database, no clock, no model.
 *
 * The grader only says "correct" when every step's check is plainly met, and
 * only says a step is wrong when the answer states the known wrong answer or
 * names the wrong line. Anything else (a paraphrase the phrases do not cover,
 * an answer that says both the right and the wrong thing) is "uncertain". A
 * false "correct" is the failure this file exists to prevent, so every doubt
 * resolves away from it.
 */

export type ChallengeGrade = "correct" | "partial" | "incorrect" | "uncertain";

/**
 * - met: the check is plainly satisfied.
 * - missed: the answer plainly states the wrong thing.
 * - unclear: the check cannot tell.
 * - conflict: the answer says both the right and the wrong thing.
 */
type StepVerdict = "met" | "missed" | "unclear" | "conflict";

type GradedStep = { id: string; label: string; verdict: StepVerdict };

export type RuleGrade = {
  grade: ChallengeGrade;
  steps: GradedStep[];
  /** The first step that was not met, the one feedback should name. Null when correct. */
  failedStep: GradedStep | null;
  /** True when an answer contradicts itself; a model opinion must not overturn this. */
  conflicted: boolean;
};

const NEGATIONS = new Set([
  "not",
  "no",
  "never",
  "cannot",
  "cant",
  "wont",
  "dont",
  "doesnt",
  "didnt",
  "isnt",
  "arent",
  "wasnt",
  "shouldnt",
  "wouldnt",
  "without",
  "neither",
  "nor",
  "fails",
  "fail",
  "unless",
]);

/** How many words before a phrase are searched for a negation. */
const NEGATION_WINDOW = 4;

/** Marks the end of a clause, so a negation never reaches across one. */
const CLAUSE_END = "|";

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[.,;:!?()]+/g, ` ${CLAUSE_END} `)
    .replace(/\b(but|because|so)\b/g, ` ${CLAUSE_END} $1 `)
    .replace(/[^a-z0-9|]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

type PhraseUse = "absent" | "stated" | "negated";

/** A phrase is negated only when every place it appears follows a negation. */
function phraseUse(answer: string[], phrase: string): PhraseUse {
  const needle = words(phrase).filter((word) => word !== CLAUSE_END);
  if (needle.length === 0) return "absent";
  let found = false;
  for (let i = 0; i + needle.length <= answer.length; i++) {
    if (!needle.every((word, offset) => answer[i + offset] === word)) continue;
    found = true;
    const before = answer.slice(Math.max(0, i - NEGATION_WINDOW), i);
    const clause = before.slice(before.lastIndexOf(CLAUSE_END) + 1);
    if (!clause.some((word) => NEGATIONS.has(word))) return "stated";
  }
  return found ? "negated" : "absent";
}

function gradeTerms(check: TermCheck, answer: string): StepVerdict {
  const tokens = words(answer);
  const groups = check.accept.map((group) => group.map((phrase) => phraseUse(tokens, phrase)));
  const stated = groups.map((uses) => uses.includes("stated"));
  // A negated wrong answer ("it does not run twice") is not a wrong answer, and
  // a negated right phrase is only ever "not stated": negation is too loose a
  // signal to call an answer wrong on.
  const statesWrongAnswer = check.reject.some((phrase) => phraseUse(tokens, phrase) === "stated");

  if (stated.every(Boolean)) return statesWrongAnswer ? "conflict" : "met";
  if (statesWrongAnswer) return stated.some(Boolean) ? "conflict" : "missed";
  return "unclear";
}

/** Line numbers an answer names: "line 4", "lines 3-5", "L7", "line 2 and 6". */
export function namedLines(answer: string): number[] {
  const found = new Set<number>();
  const pattern = /\b(?:lines?|l)\s*#?\s*(\d{1,3}(?:\s*(?:-|–|to|and|,|&)\s*\d{1,3})*)/gi;
  for (const match of answer.matchAll(pattern)) {
    const range = match[1].match(/^(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})$/i);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      for (let line = Math.min(from, to); line <= Math.max(from, to) && found.size < 60; line++) found.add(line);
      continue;
    }
    for (const digits of match[1].match(/\d{1,3}/g) ?? []) found.add(Number(digits));
  }
  return [...found];
}

function gradeLines(check: LineCheck, answer: string): StepVerdict {
  const named = namedLines(answer);
  if (named.length === 0) return "unclear";
  const right = named.filter((line) => check.lines.includes(line));
  if (right.length === named.length) return "met";
  return right.length === 0 ? "missed" : "conflict";
}

function gradeStep(check: StepCheck, answer: string): StepVerdict {
  return check.kind === "terms" ? gradeTerms(check, answer) : gradeLines(check, answer);
}

/** Folds step verdicts into one grade. Shared by every format, whatever graded its steps. */
function foldSteps(graded: GradedStep[]): RuleGrade {
  const count = (verdict: StepVerdict) => graded.filter((step) => step.verdict === verdict).length;
  const conflicted = count("conflict") > 0;
  const grade: ChallengeGrade =
    count("met") === graded.length
      ? "correct"
      : conflicted
        ? "uncertain"
        : count("missed") > 0
          ? count("met") > 0
            ? "partial"
            : "incorrect"
          : "uncertain";
  const failedStep =
    graded.find((step) => step.verdict === "missed") ?? graded.find((step) => step.verdict !== "met") ?? null;
  return { grade, steps: graded, failedStep, conflicted };
}

export function gradeByRules(steps: ChallengeStep[], answer: string): RuleGrade {
  return foldSteps(steps.map((step) => ({ id: step.id, label: step.label, verdict: gradeStep(step.check, answer) })));
}

/**
 * Whether an attempt shows the learner can do this without help: right, on
 * the first try (before the answer was ever revealed), and with no hint.
 */
export function isIndependent(attempt: { grade: ChallengeGrade | null; hintsUsed: number; ordinal: number }): boolean {
  return attempt.grade === "correct" && attempt.hintsUsed === 0 && attempt.ordinal === 0;
}
