import { z } from "zod";

/*
 * The content shape a generated deck or infographic carries inside
 * artifact_versions.content. A report is `{text}`; these two are structured,
 * and both round-trip: what is stored is what the renderer reads, and an edit
 * replaces the whole structure rather than flattening it to text.
 *
 * Every citation names a document id. The reader filters those ids against the
 * artifact's own pinned set, so a model cannot cite a source the deck was not
 * built from.
 */

export const deckSlide = z.object({
  title: z.string().trim().min(1).max(200),
  bullets: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
  /** Optional speaker note, shown only in the editor. */
  note: z.string().trim().max(2000).optional(),
  /** Document ids this slide stands on. Empty means the slide is unsourced. */
  citations: z.array(z.string().uuid()).max(10).default([]),
});

export const deckContent = z.object({
  kind: z.literal("deck"),
  slides: z.array(deckSlide).min(1).max(60),
});

export const infographicSection = z.object({
  heading: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(1200),
});

export const infographicStat = z.object({
  label: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(40),
  /** The document the number came from; required so a stat is never unattributed. */
  citation: z.string().uuid().optional(),
});

export const infographicContent = z.object({
  kind: z.literal("infographic"),
  headline: z.string().trim().min(1).max(160),
  /** One of three layouts. Anything else is a parse failure, not a guess. */
  layout: z.enum(["stats", "sections", "lede"]),
  stats: z.array(infographicStat).max(6).default([]),
  sections: z.array(infographicSection).max(6).default([]),
  citations: z.array(z.string().uuid()).max(20).default([]),
});

export type DeckContent = z.infer<typeof deckContent>;
export type DeckSlide = z.infer<typeof deckSlide>;
export type InfographicContent = z.infer<typeof infographicContent>;

export type StructuredContent = DeckContent | InfographicContent;

/** Parses stored content for a kind. Returns null when the shape does not match. */
export function parseStructuredContent(kind: string, content: unknown): StructuredContent | null {
  if (kind === "deck") {
    const parsed = deckContent.safeParse(content);
    return parsed.success ? parsed.data : null;
  }
  if (kind === "infographic") {
    const parsed = infographicContent.safeParse(content);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

/**
 * Parses a model's JSON answer into structured content. Fenced code blocks are
 * tolerated because a chat model wraps JSON in them often enough that rejecting
 * it would be a bug in the caller, not in the model.
 */
export function parseGeneratedContent(kind: "deck" | "infographic", raw: string): StructuredContent | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const withKind = typeof value === "object" && value !== null && !("kind" in value) ? { ...(value as object), kind } : value;
  return parseStructuredContent(kind, withKind);
}

/**
 * Keeps only citations that name a document the artifact was built from. An
 * unknown id is dropped rather than rendered as a dead link, and a slide that
 * loses all of its citations is reported as unsourced.
 */
export function filterCitations(
  content: StructuredContent,
  allowedDocumentIds: ReadonlySet<string>,
): { content: StructuredContent; droppedCitations: number } {
  let dropped = 0;
  const drop = (ids: string[]) => ids.filter((id) => {
    if (allowedDocumentIds.has(id)) return true;
    dropped += 1;
    return false;
  });

  if (content.kind === "deck") {
    const slides = content.slides.map((slide) => ({ ...slide, citations: drop(slide.citations) }));
    return { content: { ...content, slides }, droppedCitations: dropped };
  }

  const stats = content.stats.map((stat) => {
    if (!stat.citation) return stat;
    if (allowedDocumentIds.has(stat.citation)) return stat;
    dropped += 1;
    return { ...stat, citation: undefined };
  });
  return { content: { ...content, stats, citations: drop(content.citations) }, droppedCitations: dropped };
}

/** A plain-text projection, so search and the version list can show a deck. */
export function structuredPlainText(content: StructuredContent): string {
  if (content.kind === "deck") {
    return content.slides.map((s, i) => [`# ${i + 1}. ${s.title}`, ...s.bullets.map((b) => `- ${b}`)].join("\n")).join("\n\n");
  }
  return [content.headline, ...content.sections.map((s) => `## ${s.heading}\n${s.body}`)].join("\n\n");
}
