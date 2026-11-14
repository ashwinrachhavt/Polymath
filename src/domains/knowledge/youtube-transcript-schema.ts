import { z } from "zod";

/*
 * A YouTube transcript read by the person's own browser and sent with a
 * capture (the Chrome companion's "Capture with transcript"). The server
 * cannot fetch captions from some hosts (YouTube blocks datacenter addresses),
 * and the browser that has the video open can.
 *
 * It is client input, so it is bounded here and nowhere else trusts it: the
 * video id must be one id, cues are plain text in seconds, and the whole
 * thing has a size ceiling (a three hour talk is about 200,000 characters).
 * A supplied transcript is filed as the capture's own document and never
 * enters the shared captions cache, so one person's upload cannot become what
 * another workspace reads for the same video.
 */

const MAX_CUES = 20_000;
const MAX_CUE_TEXT = 2_000;
export const MAX_TRANSCRIPT_CHARS = 600_000;

export const suppliedTranscriptSchema = z
  .object({
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
    title: z.string().max(500).nullable().optional(),
    language: z.string().max(20).nullable().optional(),
    generated: z.boolean().optional(),
    cues: z
      .array(
        z.object({
          start: z.number().finite().min(0).max(86_400),
          duration: z.number().finite().min(0).max(86_400),
          text: z.string().min(1).max(MAX_CUE_TEXT),
        }),
      )
      .min(1)
      .max(MAX_CUES),
  })
  .refine((value) => value.cues.reduce((sum, cue) => sum + cue.text.length, 0) <= MAX_TRANSCRIPT_CHARS, {
    message: "That transcript is longer than Polymath reads.",
  });

export type SuppliedTranscript = z.infer<typeof suppliedTranscriptSchema>;
