/*
 * Drizzle needs one entry point to diff; drizzle-kit reads the `schema` glob
 * in drizzle.config.ts and finds each domain's `schema.ts` directly. This file
 * exists for runtime use — queries and `db.query` — so a caller imports the
 * table it needs from one place instead of reaching across domains.
 *
 * It re-exports, it does not define. Table ownership stays with the domain.
 */

export * from "../domains/actions/schema";
export * from "../domains/agents/schema";
export * from "../domains/applications/schema";
export * from "../domains/audit/schema";
export * from "../domains/calendar/schema";
export * from "../domains/capture/schema";
export * from "../domains/crm/schema";
export * from "../domains/focus/schema";
export * from "../domains/gamification/schema";
export * from "../domains/identity/schema";
export * from "../domains/integrations/schema";
export * from "../domains/knowledge/schema";
export * from "../domains/learning/schema";
export * from "../domains/opportunities/schema";
export * from "../domains/spending/schema";
export * from "../domains/work/schema";
