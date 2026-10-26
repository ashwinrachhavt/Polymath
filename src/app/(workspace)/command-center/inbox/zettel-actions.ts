"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import {
  MAX_ZETTEL_SOURCE_CAPTURES,
  countPendingZettelProposals,
  countZettelSourceCaptures,
  requestZettelGeneration,
} from "@/domains/capture/zettel-generation";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { capturesTag } from "@/lib/cache-tags";

/*
 * "Generate zettels" from the inbox: one click over the open captures that
 * carry text. The action only queues the work - a model call never runs inside
 * the request - so the button returns as soon as the outbox rows commit, and
 * the proposals appear in the review queue at /alfred/knowledge/zettels.
 *
 * The client sends one idempotency key per click: a double-submit returns the
 * first answer and queues nothing new. Inside a request the outbox dispatch key
 * is the second guard, so even a fresh key cannot queue a capture twice.
 */

export type GenerateZettelsResult =
  | {
      ok: true;
      /**
       * Captures queued for a proposal pass. The model runs in the outbox rather
       * than inside this request, so the number of proposals is not known when
       * the action returns - this count is what was asked for, and
       * `awaitingReview` is the queue it is filling. Reporting a proposal total
       * here would be a number nobody has produced yet.
       */
      queued: number;
      skipped: number;
      awaitingReview: number;
      replayed: boolean;
    }
  | { ok: false; message: string };

const input = z.object({
  /** Omitted (or empty) means every open capture that carries text. */
  captureIds: z.array(z.uuid()).max(MAX_ZETTEL_SOURCE_CAPTURES).optional(),
  idempotencyKey: z.uuid(),
});

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const NOTHING_TO_READ = "No open capture has text to read. Capture something first, or choose another filter.";

export async function generateZettelsAction(raw: {
  captureIds?: string[];
  idempotencyKey: string;
}): Promise<GenerateZettelsResult> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "That request was malformed. Reload the inbox and try again." };
  }
  const auth = await authorize();

  // The count is the honest answer to "nothing to generate from", and refusing
  // here costs one indexed read instead of a receipt plus an empty pass.
  const sources = await countZettelSourceCaptures(auth, { ids: parsed.data.captureIds });
  if (sources === 0) return { ok: false, message: NOTHING_TO_READ };

  let outcome: Awaited<ReturnType<typeof requestZettelGeneration>>;
  try {
    outcome = await requestZettelGeneration(auth, parsed.data);
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : "The request did not queue." };
  }

  updateTag(capturesTag(auth));
  revalidatePath("/command-center/inbox");
  revalidatePath("/alfred/knowledge/zettels");

  // A replay returns the first click's numbers; the sentence is the same either
  // way, so the person is not told their second click did something new.
  return {
    ok: true,
    queued: outcome.queued,
    skipped: outcome.skipped,
    awaitingReview: await countPendingZettelProposals(auth),
    replayed: outcome.replayed,
  };
}
