"use server";

import { revalidatePath } from "next/cache";
import { pinArtifactToDay, unpinArtifactFromDay } from "@/domains/daybook/commands";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Day-page pin actions. A pin is the daybook's only write: one row keyed
 * (workspace, user, local date, artifact). Anything else on the page derives
 * from canonical records and has no action here.
 */

type Result = { ok: true } | { ok: false; error: string };

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

export async function pinArtifactAction(input: {
  localDate: string;
  artifactId: string;
  pinnedVersionId?: string | null;
}): Promise<Result> {
  try {
    const auth = await authorize();
    await pinArtifactToDay(auth, input);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not pin this." };
  }
  revalidatePath(`/command-center/day/${input.localDate}`);
  return { ok: true };
}

export async function unpinArtifactAction(input: {
  localDate: string;
  artifactId: string;
}): Promise<Result> {
  try {
    const auth = await authorize();
    await unpinArtifactFromDay(auth, input);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not remove the pin." };
  }
  revalidatePath(`/command-center/day/${input.localDate}`);
  return { ok: true };
}
