/*
 * Materialize semantic edges for cards embedded before auto-linking shipped.
 * Dry run by default; pass --apply to write. Only workspace_id is needed by
 * the domain function, so no user context is required.
 *
 *   pnpm backfill:semantic-edges            # report
 *   pnpm backfill:semantic-edges -- --apply # write
 */
import { sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { materializeSemanticEdges } from "@/domains/knowledge/relations";
import { db } from "@/lib/db";

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = (await db.execute(sql`
    select distinct a.workspace_id as workspace_id, a.id as id
    from artifacts a
    join embeddings e on e.owner_id = a.id and e.owner_type = 'artifact'
    where a.kind in ('note', 'zettel') and a.archived_at is null
  `)) as unknown as { workspace_id: string; id: string }[];
  let edges = 0;
  for (const row of rows) {
    if (!apply) continue;
    edges += await materializeSemanticEdges({ workspaceId: row.workspace_id } as AuthContext, row.id);
  }
  console.log(`${rows.length} embedded cards; ${apply ? `${edges} semantic edges written` : "dry run, pass --apply to write"}`);
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
