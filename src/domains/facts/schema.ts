import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { primaryId } from "../../db/columns";

/*
 * Facts a background pass drafted with a model. The curated deck in
 * src/lib/poll-facts.ts is the quality bar and needs no rows; these are the
 * extras a monthly job adds. Global, not tenant-scoped: the same fact can
 * amuse every workspace, and the uniqueness lives on the text so two passes
 * (or a pass and the deck) cannot land the same line twice.
 */

export const pollFactSuggestions = pgTable(
  "poll_fact_suggestions",
  {
    id: primaryId(),
    text: text("text").notNull().unique(),
    topic: text("topic").notNull(),
    tags: jsonb("tags").$type<string[]>().notNull(),
    status: text("status").notNull().default("active"),
    source: text("source").notNull().default("job"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("poll_fact_suggestions_status_idx").on(t.status, t.createdAt)],
);

export type PollFactSuggestion = typeof pollFactSuggestions.$inferSelect;
