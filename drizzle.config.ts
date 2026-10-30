import { defineConfig } from "drizzle-kit";

/*
 * Migrations are forward-only SQL, generated here and reviewed before they
 * run. Each domain owns a schema module; this glob list is the only place the
 * set of them is enumerated, and drizzle-kit resolves the intra-schema imports
 * (shared columns, cross-domain foreign keys) itself. The second pattern
 * covers domain sub-modules (`runtime-schema.ts`, `statement-schema.ts`, ...):
 * a sub-module outside this list is invisible to generate, which is how the
 * seven agents-runtime and statement-ledger tables nearly fell out of the
 * model (2026-10-30).
 */

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error("DATABASE_URL is not set. Drizzle needs it to diff or apply migrations.");
}

export default defineConfig({
  schema: ["./src/domains/*/schema.ts", "./src/domains/*/*-schema.ts"],
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
});
