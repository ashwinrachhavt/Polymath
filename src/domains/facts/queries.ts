import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import type { PollFact } from "@/lib/poll-facts";
import { pollFactSuggestions } from "./schema";

/** The active suggestions, newest first, bounded: FactPoll shuffles whatever it gets. */
export async function activeSuggestions(limit = 40): Promise<PollFact[]> {
  const rows = await db
    .select({
      id: pollFactSuggestions.id,
      kind: pollFactSuggestions.topic,
      tags: pollFactSuggestions.tags,
      text: pollFactSuggestions.text,
    })
    .from(pollFactSuggestions)
    .where(eq(pollFactSuggestions.status, "active"))
    .orderBy(pollFactSuggestions.createdAt)
    .limit(limit);
  // The column is text; the write path (parseSuggestions) is the only writer
  // and admits just the two topics, so the narrow is the stored invariant.
  return rows.filter((row): row is PollFact => row.kind === "science" || row.kind === "philosophy");
}
