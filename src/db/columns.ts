import { sql } from "drizzle-orm";
import { check, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "../domains/identity/tables";

/*
 * The shape every mutable tenant record shares (agents/engineering.md):
 * a uuid primary key, an integer `version` for optimistic concurrency, and
 * timestamptz bookkeeping. Spread these into a table's column map rather than
 * retyping them; a column declared here and nowhere else cannot drift.
 *
 * `createdBy`/`updatedBy` carry no foreign key on purpose — identity already
 * points at work, capture, and audit through real FKs, and adding the reverse
 * would make every domain schema importable from identity.
 */

export const primaryId = () => uuid("id").primaryKey().defaultRandom();

/** Foreign key to the tenant boundary. Every owned table has one. */
export const tenantId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

export const mutable = {
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
};

/** Append-only rows: they are written once, so they carry no version or authors. */
export const recorded = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
};

/** Append-only rows that still record who wrote them. */
export const recordedBy = {
  createdBy: uuid("created_by"),
  ...recorded,
};

/*
 * The record kinds a link row may point at. `targetId` carries no foreign key
 * (a polymorphic FK is not expressible), so this list plus a check constraint
 * on each link table is what stops a typo from inventing a new kind. One list,
 * because two link tables disagreeing about what a "document" is called is the
 * bug the constraint exists to prevent.
 */
export const linkTargetKinds = [
  "task",
  "project",
  "space",
  "note",
  "artifact",
  "document",
  "source",
  "event",
  "contact",
  "company",
  "person",
  "organization",
  "opportunity",
  "run",
  "thread",
  "zettel",
] as const;

export const linkTargetKind = () => text("target_type").notNull();

/*
 * The `check` predicate paired with `linkTargetKind()`. `sql.raw` on purpose:
 * a bound parameter renders as `$1` in the generated migration, and a `.sql`
 * file has no bind step, so the literal list has to be written out. Safe
 * because `linkTargetKinds` is a compile-time constant, not input.
 */
export const linkTargetKindCheck = (name: string) =>
  check(
    name,
    sql.raw(`target_type in (${linkTargetKinds.map((k) => `'${k}'`).join(", ")})`),
  );

/*
 * Why a link row exists. `reference` is an explicit [[Title]] or a manually
 * created edge; `source` is provenance (a zettel points at the document it
 * was decomposed from); `semantic` is a machine-proposed similarity edge and
 * always carries `score`; `related`, `supports` and `contradicts` are the
 * human-curated relation types. One vocabulary, because a free-text type
 * column is how link graphs rot.
 */
export const artifactLinkTypes = [
  "reference",
  "related",
  "supports",
  "contradicts",
  "source",
  "semantic",
  "explains",
  "applies",
  "extends",
  "contrasts",
  "dismissed",
  "instance_of",
  "part_of",
  "causes",
] as const;

export const artifactLinkType = () => text("link_type").notNull().default("reference");

export const artifactLinkTypeCheck = (name: string) =>
  check(
    name,
    sql.raw(`link_type in (${artifactLinkTypes.map((k) => `'${k}'`).join(", ")})`),
  );
