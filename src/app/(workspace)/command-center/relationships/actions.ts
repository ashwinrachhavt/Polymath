"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { importConnections, type ImportSummary } from "@/domains/identity/party-csv";
import { getAuthContext } from "@/lib/auth";

/*
 * Relationships mutations. One today: import a connections file. Owner-initiated,
 * so it resolves the owner from Clerk first and revalidates the screen that
 * reads the result.
 *
 * The import takes CSV text, not a File: the client reads the file and posts
 * the string, which keeps this a plain server action instead of a route
 * handler with a body-size contract to maintain.
 */

const revalidate = () => revalidatePath("/command-center/relationships");

const importInput = z.object({
  csv: z.string().min(1).max(5_000_000),
});

export async function importConnectionsCsv(input: {
  csv: string;
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
