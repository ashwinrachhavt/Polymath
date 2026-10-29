import { sql } from "drizzle-orm";
import { seedTaxonomyCatalog, SEED_TAXONOMY } from "@/domains/knowledge/taxonomy";
import { db } from "@/lib/db";

/*
 * Seed the ASH-272 knowledge taxonomy (22 Neuralflow domains + 12 example
 * subdomain/microtopic nodes) into every workspace, or one with
 * --workspace <id>. Idempotent: a re-run changes nothing.
 *
 * Retirement contract: seedTaxonomyCatalog also deletes any node whose slug
 * is not in the seed, so a re-run after the seed shrinks retires the removed
 * labels (children first, see taxonomy.ts). Captures store domain slugs as
 * text with no FK, so retired labels in old captures are unresolvable, not
 * broken.
 *
 *   pnpm seed:taxonomy                          dry run, prints the plan
 *   pnpm seed:taxonomy -- --apply               writes
 *   pnpm seed:taxonomy -- --apply --workspace <uuid>
 */

async function main() {
  const apply = process.argv.includes("--apply");
  const wIndex = process.argv.indexOf("--workspace");
  const only = wIndex >= 0 ? process.argv[wIndex + 1] : null;
  const rows = (await db.execute(
    only
      ? sql`select id from workspaces where id = ${only}::uuid and archived_at is null`
      : sql`select id from workspaces where archived_at is null`,
  )) as unknown as { id: string }[];
  console.log(
    `${apply ? "Seeding" : "Would seed"} ${SEED_TAXONOMY.length} taxonomy nodes into ${rows.length} workspace(s)`,
  );
  if (!apply) return;
  for (const row of rows) {
    await seedTaxonomyCatalog(row.id);
  }
  console.log("done");
}

main().then(() => process.exit(0)).catch((cause) => {
  console.error(cause);
  process.exit(1);
});
