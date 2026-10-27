"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import { applyShutdown, ShutdownIncompleteError, ShutdownStaleError, type ShutdownResult } from "@/domains/daybook/shutdown";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { capturesTag, tasksTag } from "@/lib/cache-tags";

/*
 * The shutdown ritual's one write (ASH-305). Every choice arrives explicitly
 * from the form; the domain refuses an apply that leaves a live session
 * undecided. No email is sent here: a recipient plus account only files a
 * proposal in the review queue.
 */

const input = z.object({
  idempotencyKey: z.string().uuid(),
  session: z
    .discriminatedUnion("action", [
      z.object({ action: z.literal("leave"), sessionId: z.string().uuid(), expectedVersion: z.number().int() }),
      z.object({
        action: z.literal("abandon"),
        sessionId: z.string().uuid(),
        expectedVersion: z.number().int(),
        reason: z.string().max(500).nullish(),
      }),
      z.object({
        action: z.literal("finish"),
        sessionId: z.string().uuid(),
        expectedVersion: z.number().int(),
        outcome: z.string().max(2000).nullish(),
        whatChanged: z.string().max(2000).nullish(),
        nextStep: z.string().max(2000).nullish(),
      }),
    ])
    .optional(),
  park: z.array(z.object({ captureId: z.string().uuid(), expectedVersion: z.number().int() })).max(50),
  seedTaskIds: z.array(z.string().uuid()).max(20),
  email: z.object({ to: z.string().trim().max(320), accountAlias: z.string().trim().max(200).nullable() }).nullish(),
});

export type ShutdownActionInput = z.input<typeof input>;
export type ShutdownActionResult = { ok: true; result: ShutdownResult } | { ok: false; error: string };

export async function applyShutdownAction(raw: ShutdownActionInput): Promise<ShutdownActionResult> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That shutdown request was not valid. Reload and try again." };
  try {
    const result = await applyShutdown(auth, { ...parsed.data, email: parsed.data.email ?? null });
    updateTag(capturesTag(auth));
    updateTag(tasksTag(auth));
    revalidatePath("/");
    revalidatePath("/command-center/inbox");
    return { ok: true, result };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (error instanceof ShutdownIncompleteError || error instanceof ShutdownStaleError || code === "stale_write" || code === "conflict") {
      return { ok: false, error: (error as Error).message };
    }
    throw error;
  }
}
