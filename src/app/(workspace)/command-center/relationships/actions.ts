"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  importConnections,
  linkPersonToOrganization,
  type ImportSummary,
} from "@/domains/identity/party-csv";
import { getAuthContext } from "@/lib/auth";

/*
 * Relationships mutations. Two of them: import a connections file, and link a
 * person to an organization by hand. Both are owner-initiated, so both resolve
 * the owner from Clerk first and revalidate the one screen that reads their
 * result.
 *
 * The import takes CSV text, not a File: the client reads the file and posts
 * the string, which keeps this a plain server action instead of a route
 * handler with a body-size contract to maintain.
 */

const revalidate = () => revalidatePath("/command-center/relationships");

const importInput = z.object({
  csv: z.string().min(1).max(5_000_000),
  fileName: z.string().max(200).optional(),
});

export async function importConnectionsCsv(input: {
  csv: string;
  fileName?: string;
}): Promise<{ ok: true; summary: ImportSummary } | { ok: false; error: string }> {
  const parsed = importInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That file could not be read as text." };

  const auth = await getAuthContext();
  try {
    const summary = await importConnections(auth, { csv: parsed.data.csv });
    revalidate();
    return { ok: true, summary };
  } catch (error) {
    // A thrown message here is a deliberate refusal ("row limit"), not a
    // stack trace; anything else is rethrown to the error boundary.
    if (error instanceof Error && /import limit/.test(error.message)) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

const linkInput = z.object({
  personId: z.string().uuid(),
  organizationId: z.string().uuid(),
  title: z.string().trim().max(200).optional(),
});

export async function linkPersonToOrg(input: {
  personId: string;
  organizationId: string;
  title?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = linkInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick a person and an organization." };

  const auth = await getAuthContext();
  try {
    await linkPersonToOrganization(auth, parsed.data);
    revalidate();
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && /not found in workspace/.test(error.message)) {
      return { ok: false, error: "That record is not in this workspace." };
    }
    throw error;
  }
}
