import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { mutable, primaryId, tenantId } from "../../db/columns";

/*
 * A skill is a stored instruction package: a SKILL.md body plus the files it
 * ships. It is data, never code — nothing imported is executed, and the body is
 * never interpolated into SQL, shell, or a path.
 *
 * Identity is (workspace, source_kind, source_ref, source_path), not the slug:
 * a display name may change, and two packages in one repo may share a slug. A
 * run pins skill id, revision and content hash into its policy snapshot, so a
 * later edit here cannot rewrite what a past run was told.
 */
export const skillSourceKinds = ["github", "local", "bundled"] as const;
export type SkillSourceKind = (typeof skillSourceKinds)[number];

export type SkillFile = { path: string; text: string };

export const skills = pgTable(
  "skills",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    /** The procedure text, verbatim. Untrusted input, stored as data. */
    body: text("body").notNull(),
    /** `[{ path, text }]`; binaries are a warning, never a stored blob. */
    files: jsonb("files").notNull().default([]).$type<SkillFile[]>(),
    sourceKind: text("source_kind").notNull().$type<SkillSourceKind>(),
    /** The repo, folder, or bundled key this came from. */
    sourceRef: text("source_ref").notNull(),
    /** Where in that source the package sits; part of identity. */
    sourcePath: text("source_path").notNull(),
    /** The resolved commit SHA for GitHub, the content hash for local. */
    revision: text("revision").notNull(),
    /** sha256 over the normalised package, so a re-import is detectable without blobs. */
    contentHash: text("content_hash").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Inspection gaps that did not stop the install (skipped binaries, submodules). */
    warnings: jsonb("warnings").notNull().default([]).$type<string[]>(),
    ...mutable,
  },
  (t) => [
    check(
      "skills_source_kind_check",
      sql.raw(`"source_kind" in (${skillSourceKinds.map((kind) => `'${kind}'`).join(", ")})`),
    ),
    uniqueIndex("skills_identity_key").on(t.workspaceId, t.sourceKind, t.sourceRef, t.sourcePath),
    index("skills_workspace_enabled_idx").on(t.workspaceId, t.enabled),
  ],
);

export type Skill = typeof skills.$inferSelect;
