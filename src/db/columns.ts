import { integer, timestamp, uuid } from "drizzle-orm/pg-core";
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
