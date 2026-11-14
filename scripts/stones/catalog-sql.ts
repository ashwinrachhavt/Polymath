/*
 * Prints the INSERT that seeds the `stones` table from catalog.json, for
 * pasting into a migration:
 *
 *   pnpm exec tsx scripts/stones/catalog-sql.ts > /tmp/stones.sql
 *
 * `position` is the catalog's order (by tier, then price, then name).
 */
import { loadCatalog } from "./catalog";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

const rows = loadCatalog().map((s, index) =>
  [
    quote(s.slug),
    quote(s.name),
    quote(s.family),
    quote(s.formula),
    quote(s.color),
    quote(s.hardness),
    quote(s.origin),
    quote(s.fact),
    quote(s.lore),
    quote(s.tier),
    String(s.price),
    String(index + 1),
  ].join(", "),
);

process.stdout.write(
  `INSERT INTO "stones" ("slug", "name", "family", "formula", "color", "hardness", "origin", "fact", "lore", "tier", "price", "position") VALUES\n` +
    rows.map((row) => `(${row})`).join(",\n") +
    ";",
);
