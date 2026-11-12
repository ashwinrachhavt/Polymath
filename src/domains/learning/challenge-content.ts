import { z } from "zod";

/*
 * What a practice challenge stores. One discriminated union for every format,
 * parsed at the boundary (model output in, database row out), so a new format
 * is a new member here and never a new table.
 *
 * A challenge is a list of steps the learner's answer must get right. Each
 * step carries the exact check that grades it, which is what lets
 * `challenge-grading.ts` reach a verdict without a model.
 */

/**
 * A step met by wording. Every `accept` group must be stated, and a group is
 * stated by any one of its phrases. `reject` lists phrases that state the known
 * wrong answer.
 */
const termCheckSchema = z.object({
  kind: z.literal("terms"),
  accept: z
    .array(z.array(z.string().trim().min(2).max(80)).min(1).max(10))
    .min(1)
    .max(4),
  reject: z.array(z.string().trim().min(2).max(80)).max(10),
});

/** A step met by naming one of these lines of the artifact (1-based). */
const lineCheckSchema = z.object({
  kind: z.literal("lines"),
  lines: z.array(z.number().int().positive()).min(1).max(4),
});

export type TermCheck = z.infer<typeof termCheckSchema>;
export type LineCheck = z.infer<typeof lineCheckSchema>;
export type StepCheck = TermCheck | LineCheck;

const shared = {
  /** The one thing this challenge shows the learner can do. A later concept link attaches here. */
  objective: z.string().trim().min(8).max(200),
  question: z.string().trim().min(8).max(400),
  /** A complete answer, shown only after the learner commits one. */
  answer: z.string().trim().min(8).max(900),
  /** The rule the answer rests on, in one sentence. */
  rule: z.string().trim().min(8).max(400),
  /** Shown one at a time, least revealing first. */
  hints: z.array(z.string().trim().min(4).max(300)).min(1).max(3),
};

const predictSchema = z.object({
  format: z.literal("predict"),
  ...shared,
  situation: z.string().trim().min(20).max(1200),
  outcome: termCheckSchema,
  reason: termCheckSchema,
});

const bugHuntSchema = z.object({
  format: z.literal("bug_hunt"),
  ...shared,
  artifact: z.object({
    kind: z.enum(["log", "code"]),
    lines: z.array(z.string().max(200)).min(3).max(40),
  }),
  fault: lineCheckSchema,
  invariant: termCheckSchema,
});

export const challengeContentSchema = z
  .discriminatedUnion("format", [predictSchema, bugHuntSchema])
  .refine(
    (content) =>
      content.format !== "bug_hunt" || content.fault.lines.every((line) => line <= content.artifact.lines.length),
    { message: "A fault line is outside the artifact." },
  );

export type ChallengeContent = z.infer<typeof challengeContentSchema>;
export type ChallengeFormat = ChallengeContent["format"];
export const CHALLENGE_FORMATS = ["predict", "bug_hunt"] as const satisfies readonly ChallengeFormat[];

export type ChallengeStep = { id: string; label: string; check: StepCheck };

/** The steps an answer is graded on, in the order feedback names them. */
export function challengeSteps(content: ChallengeContent): ChallengeStep[] {
  switch (content.format) {
    case "predict":
      return [
        { id: "outcome", label: "what happens", check: content.outcome },
        { id: "reason", label: "why it happens", check: content.reason },
      ];
    case "bug_hunt":
      return [
        { id: "fault", label: "where it goes wrong", check: content.fault },
        { id: "invariant", label: "the rule it breaks", check: content.invariant },
      ];
  }
}
