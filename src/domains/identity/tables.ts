import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/*
 * The two tables everything else points at: `workspaces` is the tenant
 * boundary, so `src/db/columns.ts` has to be able to reference it, and every
 * other table uses the column helpers. Importing the helpers here would close
 * that loop, so this file — and only this file — spells its columns out.
 *
 * It is the root of the import graph; nothing here imports a domain.
 */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email"),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** One owner in v1; the column exists so tenancy is never retrofitted. */
  isPersonal: boolean("is_personal").notNull().default(true),
  /** Set when the workspace's onboarding conversation completes. */
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
});
