import { z } from "zod";
import { onboardingBriefSchema } from "./onboarding-brief";

/*
 * The detached wizard's pure pieces: the step ladder, the persisted draft
 * shape, and the one LLM assist's contract (input schema, system voice,
 * prompt composition). The wizard asks its questions in forms, not in a chat
 * run, so "where the person is" is the session row's step and draft, and the
 * single assist is a direct structured-output call whose Zod schema is the
 * response contract. Nothing here opens a database or calls a model —
 * onboarding.ts owns the await-able assist; this module is what it, the
 * actions, and the reload decision can all hold without side effects.
 */

/** The wizard's steps, in order; the session row's default is the first. */
export const ONBOARDING_STEPS = ["role", "priorities", "words", "review"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * What the wizard persists between steps: any subset of the brief (the step
 * 1–2 selections, later the composed draft the review edits) plus the
 * freeform words from step 3, which the brief schema has no field for.
 */
export const onboardingDraftSchema = onboardingBriefSchema.partial().extend({
  freeform: z.string().trim().max(4_000).optional(),
});
export type OnboardingDraft = z.infer<typeof onboardingDraftSchema>;

/** The assist's input: the selections so far plus the person's own words. */
export const freeformDraftSchema = z.object({
  role: z.string().trim().max(200).optional(),
  tools: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  priorities: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  freeform: z.string().trim().min(1).max(4_000),
});
export type FreeformDraft = z.infer<typeof freeformDraftSchema>;

/**
 * The assist's system voice, matching the interview script's (it is the same
 * meeting — the person's own agent learning who they are): compose from
 * their words, never invent what they did not give, and default the name.
 */
export const ONBOARDING_ASSIST_SYSTEM = [
  "You compose a workspace's onboarding brief. The person has answered onboarding questions in their own words; turn their answers into the brief their agent will live by: what they do, which tools they work in every day, and what matters most to them.",
  'Stay in their words: sharpen and organize, but never invent facts, tools, or priorities they did not give. If they did not pick a name for their agent, use "Polymath".',
  "Reply with only the structured brief.",
].join(" ");

/** The assist's user prompt: the selections, then the words, verbatim. */
export function composeAssistPrompt(input: FreeformDraft): string {
  return [
    `Their role: ${input.role?.trim() || "not answered yet"}`,
    `Their tools: ${input.tools?.length ? input.tools.join(", ") : "not answered yet"}`,
    `What matters most to them: ${input.priorities?.length ? input.priorities.join("; ") : "not answered yet"}`,
    "",
    "In their own words:",
    '"""',
    input.freeform,
    '"""',
    "",
    "Compose the brief from these answers.",
  ].join("\n");
}

/**
 * A session row's persisted wizard state, with anything the row cannot
 * honestly carry — an out-of-range step, an unparseable draft — collapsed to
 * the fresh-wizard defaults. The reload decision and the page both read
 * through this, so a garbage value degrades to step one instead of breaking
 * the flow.
 */
export function readWizardState(row: { step: string; draft: unknown } | null): {
  step: OnboardingStep;
  draft: OnboardingDraft | null;
} {
  if (!row) return { step: "role", draft: null };
  const step = (ONBOARDING_STEPS as readonly string[]).includes(row.step) ? (row.step as OnboardingStep) : "role";
  const parsed = onboardingDraftSchema.safeParse(row.draft);
  return { step, draft: parsed.success ? parsed.data : null };
}
