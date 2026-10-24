import { sql } from "drizzle-orm";
import { date, index, integer, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { artifacts } from "../knowledge/schema";
import { users } from "../identity/tables";
import { primaryId, recordedBy, tenantId } from "@/db/columns";

/*
 * A pin is the only persisted day state (eng review D8): everything else on a
 * day page derives from canonical records at read time. The day itself is a
 * view — a local date plus the owner's timezone, never a stored row.
 *
 * pinned_version_id has no direct FK: the composite FK
 * (pinned_version_id, artifact_id) -> artifact_versions(id, artifact_id) is
 * what makes a cross-artifact version pin impossible at the row level. The
 * composite unique index on artifact_versions it requires lives in the same
 * migration.
 */
export const dayArtifactPins = pgTable(
  "day_artifact_pins",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    localDate: date("local_date").notNull(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    pinnedVersionId: uuid("pinned_version_id"),
    position: integer("position").notNull().default(0),
    ...recordedBy,
  },
  (t) => [
    uniqueIndex("day_artifact_pins_day_key").on(
      t.workspaceId,
      t.userId,
      t.localDate,
      t.artifactId,
    ),
    index("day_artifact_pins_day_idx").on(t.workspaceId, t.userId, t.localDate),
    // The pair must match a real version row of exactly this artifact.
    sql`FOREIGN KEY (pinned_version_id, artifact_id) REFERENCES artifact_versions (id, artifact_id)`,
  ],
);
