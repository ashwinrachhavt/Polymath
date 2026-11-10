import { z } from "zod";

/*
 * What a capture knows about where it came from and why it was kept. Every
 * field is optional: the default capture asks for nothing, and "I don't know
 * yet" is a complete answer to why it matters. The context arrives with the
 * capture and is stored beside the original in raw_payload, so it is as
 * immutable as the words themselves.
 */

const text = (max: number) => z.string().trim().min(1).max(max);

export const captureContextSchema = z
  .object({
    /** Who or what the capture came from, as far as the capturing surface could tell. */
    source: z
      .object({
        kind: z.enum(["web", "app", "conversation", "document", "screenshot", "other"]).optional(),
        title: text(500).optional(),
        author: text(300).optional(),
        url: z.string().url().max(2_000).optional(),
        /** When the source itself was published or last changed, if it says. */
        publishedAt: z.string().datetime({ offset: true }).optional(),
        /** A source-side version: a document revision, a commit, an edit id. */
        version: text(200).optional(),
      })
      .strict()
      .optional(),
    /** When the person captured it, on their clock. The row's createdAt is the server's. */
    capturedAt: z.string().datetime({ offset: true }).optional(),
    /** The exact highlighted words, verbatim. */
    passage: text(20_000).optional(),
    /** The text around the passage, so it can be read later without the source. */
    surrounding: z
      .object({ before: text(4_000).optional(), after: text(4_000).optional() })
      .strict()
      .optional(),
    /** The part of a screenshot that mattered, in the image's own pixels. */
    region: z
      .object({
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .strict()
      .optional(),
    /** The conversation turn the capture came from. */
    turn: z
      .object({
        conversationId: text(200).optional(),
        messageId: text(200).optional(),
        role: z.enum(["user", "assistant", "other"]).optional(),
      })
      .strict()
      .optional(),
    /** Set when what was stored is not the whole of what was captured. */
    partial: z
      .object({ reason: text(500) })
      .strict()
      .optional(),
    /** Optional. "unknown" is the honest answer and a valid one. */
    why: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("answer"), text: text(4_000), via: z.enum(["text", "voice"]) }).strict(),
        z.object({ kind: z.literal("unknown") }).strict(),
      ])
      .optional(),
    /** Where it might belong. A suggestion only: nothing is filed by it. */
    suggestion: z
      .object({
        projectId: z.string().uuid().optional(),
        /** Resolved on the server from projectId; a client-sent title is ignored. */
        projectTitle: text(300).optional(),
        question: text(1_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CaptureContext = z.infer<typeof captureContextSchema>;

/** The stored context of a capture row, or null when it has none (or an older shape). */
export function readCaptureContext(rawPayload: unknown): CaptureContext | null {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const parsed = captureContextSchema.safeParse((rawPayload as { context?: unknown }).context);
  return parsed.success ? parsed.data : null;
}

/** True when the context says anything at all; an empty object is not stored. */
export function hasCaptureContext(context: CaptureContext | undefined): context is CaptureContext {
  return Boolean(context && Object.values(context).some((value) => value !== undefined));
}
