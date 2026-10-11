import { defineConfig } from "drizzle-kit";

/*
 * Migrations are forward-only SQL, generated here and reviewed before they
 * run (agents/engineering.md). Each domain owns its `schema.ts`; this glob is
 * the only place the set of them is enumerated, and drizzle-kit resolves the
 * intra-schema imports (shared columns, cross-domain foreign keys) itself.
 */

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error("DATABASE_URL is not set. Drizzle needs it to diff or apply migrations.");
}

export default defineConfig({
  schema: "./src/domains/*/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
});
