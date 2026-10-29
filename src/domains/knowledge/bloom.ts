import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import type { AuthContext } from "@/domains/identity/resolve";
import { artifacts } from "./schema";

/*
 * Bloom = practice suggestion, never mastery (plan §6). The annotation lives
 * in artifacts.metadata under the `bloom` namespace (§16.8): writers merge
 * by namespace via jsonb_set on their own key, never read-modify-write of
 * the whole object, and the annotation write leaves the human `updated_at`
 * untouched (the drizzle-trap the Bloom test asserts). A generated level is
 * NEVER converted to a knowledge-confidence score: learner performance stays
 * exclusively in card_reviews (0240).
 */

export const BLOOM_LEVELS = { 1: "Recall", 2: "Apply", 3: "Analyze" } as const;
export type BloomLevel = keyof typeof BLOOM_LEVELS;
export const BLOOM_PROMPT_VERSION = "bloom-practice-v1";

export type BloomAnnotation = {
  level: BloomLevel;
  levelName: string;
  rationale: string;
  source: "creation-run";
  model: string;
  promptVersion: string;
  /** The artifact version the level was inferred from - it never silently covers later edits. */
  artifactVersionNumber: number;
  annotatedAt: string;
};

const classification = z.object({
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  rationale: z.string().min(1).max(300),
});

export const BLOOM_SYSTEM_PROMPT = `You judge the practice a note most invites. Return JSON {"level":1|2|3,"rationale":"one sentence"}.
1 = Recall (restate or recognize it), 2 = Apply (use it in a situation), 3 = Analyze (compare or weigh it against others).
Pick the SINGLE practice the note's claim most naturally supports.`;

/**
 * The §16.8 namespace write: jsonb_set merges ONLY the bloom key and the
 * update sets no updatedAt/updatedBy - an annotation is not a human edit.
 */
export async function annotateBloom(
  auth: AuthContext,
  input: { artifactId: string; annotation: BloomAnnotation },
): Promise<void> {
  await db
    .update(artifacts)
    .set({
      metadata: sql`jsonb_set(coalesce(${artifacts.metadata}, '{}'::jsonb), '{bloom}', ${JSON.stringify(input.annotation)}::jsonb, true)`,
    })
    .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.workspaceId, auth.workspaceId), isNull(artifacts.archivedAt)));
}

/** One JSON classify call; the caller maps failures to its stage contract. */
export async function classifyBloomLevel(
  generate: (input: { system: string; prompt: string }) => Promise<{ text: string }>,
  input: { plainText: string; model: string; artifactVersionNumber: number },
): Promise<BloomAnnotation> {
  const out = await generate({ system: BLOOM_SYSTEM_PROMPT, prompt: input.plainText.slice(0, 4000) });
  const parsed = classification.parse(JSON.parse(out.text));
  return {
    level: parsed.level,
    levelName: BLOOM_LEVELS[parsed.level],
    rationale: parsed.rationale,
    source: "creation-run",
    model: input.model,
    promptVersion: BLOOM_PROMPT_VERSION,
    artifactVersionNumber: input.artifactVersionNumber,
    annotatedAt: new Date().toISOString(),
  };
}
