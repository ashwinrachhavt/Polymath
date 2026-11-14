import { COIN_RULES } from "./awards";

/*
 * Earn guidance: how much more work buys the stone you want, in the activities
 * people actually do. Pure, computed from the award rules in awards.ts.
 *
 * "Typical" is what a normal sitting pays: a quiz answered about three quarters
 * right, a mock interview with about half the concepts proven, a flashcard or a
 * task (which pay a flat amount). The line is a rough guide, so it says
 * "about".
 */

export const TYPICAL_COINS = {
  quiz: COIN_RULES.quiz.base + Math.round(COIN_RULES.quiz.forScore * 0.75),
  flashcard: COIN_RULES.flashcard.base,
  task: COIN_RULES.task.base,
} as const;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "About 3 quizzes or 60 flashcards to afford Amethyst (120 coins)", or that it can be bought now. */
export function earnGuidance(input: { balance: number; name: string; price: number }): string {
  const need = input.price - input.balance;
  if (need <= 0) return `You can buy ${input.name} now (${input.price} coins).`;
  const quizzes = Math.ceil(need / TYPICAL_COINS.quiz);
  const cards = Math.ceil(need / TYPICAL_COINS.flashcard);
  const tasks = Math.ceil(need / TYPICAL_COINS.task);
  const options = [
    plural(quizzes, "quiz", "quizzes"),
    plural(cards, "flashcard", "flashcards"),
    ...(tasks <= 12 ? [plural(tasks, "task", "tasks")] : []),
  ];
  const list = options.length > 2 ? `${options.slice(0, -1).join(", ")} or ${options.at(-1)}` : options.join(" or ");
  return `About ${list} to afford ${input.name} (${input.price} coins).`;
}

export type EarnRow = {
  kind: "quiz" | "flashcard" | "mission_mock" | "task";
  label: string;
  /** Coins this activity can still pay today. */
  remaining: number;
  /** Its daily ceiling. */
  cap: number;
  hint: string;
};

type Reason = (typeof COIN_RULES)[keyof typeof COIN_RULES]["reason"];

/** Today's remaining earnable coins by activity, each respecting its daily ceiling. */
export function waysToEarn(earnedToday: Partial<Record<Reason, number>>): EarnRow[] {
  const { quiz, flashcard, mission_mock: mock, task } = COIN_RULES;
  const rows: Array<[EarnRow["kind"], string, (typeof COIN_RULES)[keyof typeof COIN_RULES], string]> = [
    ["quiz", "Quizzes", quiz, `${quiz.base} to ${quiz.base + quiz.forScore} each by score, once per quiz a day`],
    ["flashcard", "Flashcards", flashcard, `${flashcard.base} per card, once per card a day`],
    [
      "mission_mock",
      "Mock interviews",
      mock,
      `${mock.base} to ${mock.base + mock.forScore} each by readiness, once per mission a day`,
    ],
    ["task", "Tasks", task, `${task.base} per task finished`],
  ];
  return rows.map(([kind, label, rule, hint]) => ({
    kind,
    label,
    remaining: Math.max(0, rule.dailyCap - (earnedToday[rule.reason] ?? 0)),
    cap: rule.dailyCap,
    hint,
  }));
}
