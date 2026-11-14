import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/*
 * The stone catalog's authoring source: scripts/stones/catalog.json, 200
 * stones written once and reviewed. Migrations seed the `stones` table from
 * it (catalog-sql.ts prints the INSERT) and the art script draws from it; the
 * app reads only the table. A later correction is an edit here plus a new
 * migration, and the catalog integrity test keeps the two equal.
 */

export const TIER_BANDS = {
  legendary: { count: 2, min: 1000, max: 2000, step: 100 },
  precious: { count: 18, min: 300, max: 600, step: 25 },
  semi_precious: { count: 70, min: 100, max: 200, step: 10 },
  crystal: { count: 110, min: 30, max: 70, step: 5 },
} as const;

const text = (max: number) => z.string().trim().min(1).max(max);

const catalogEntrySchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: text(60),
  family: text(80),
  formula: text(120),
  color: text(120),
  hardness: z.string().regex(/^\d+(\.\d+)?(–\d+(\.\d+)?)?$/),
  origin: text(160),
  fact: text(160),
  lore: text(160),
  tier: z.enum(["legendary", "precious", "semi_precious", "crystal"]),
  price: z.number().int().positive(),
  /** The art brief: what the specimen looks like. Not stored in the database. */
  look: text(140),
});

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export function loadCatalog(): CatalogEntry[] {
  const raw: unknown = JSON.parse(readFileSync(resolve(import.meta.dirname, "catalog.json"), "utf8"));
  return z.array(catalogEntrySchema).parse(raw);
}
