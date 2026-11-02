"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { explainLink } from "@/domains/knowledge/link-rationale";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/* Graph canvas writes: the "why" of one edge, generated the first time someone opens it. */

const rationaleInput = z.object({ linkId: z.string().uuid() });

type Result = { ok: true; context: string } | { ok: false; error: string };

export async function explainLinkAction(input: z.input<typeof rationaleInput>): Promise<Result> {
  const parsed = rationaleInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick a link to explain." };
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const { context } = await explainLink(auth, { linkId: parsed.data.linkId });
    revalidatePath("/polymath/graph");
    return { ok: true, context };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not write the rationale." };
  }
}
