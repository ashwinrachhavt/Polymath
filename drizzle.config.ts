import { defineConfig } from "drizzle-kit";

/*
 * Migrations are forward-only SQL, generated here and reviewed before they
 * run (agents/engineering.md). Each domain owns its `schema.ts`; this glob is
 * the only place the set of them is enumerated.
 *
 * Schema land in the domains that own them — there are none yet, so
 * `pnpm db:generate` has nothing to read until the identity domain lands.
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
