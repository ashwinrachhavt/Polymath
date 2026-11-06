import {
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId, recordedBy, tenantId } from "../../db/columns";
import { agentProfiles } from "./schema";

/*
 * Durable profile revisions (ASH-117). The reference carries workspace_id in a
 * composite foreign key, because a workspace column alone isolates nothing.
 *
 * The execution/signal/invocation tables that once shared this module wrote to
 * rows no code read (verified dead, 2026-11) and were removed; migration 0285
 * drops them. `effectClasses` survives here because tool authorization
 * classifies effects by it.
 */

export const effectClasses = ["read", "internal_write", "external_effect", "paid"] as const;
export type EffectClass = (typeof effectClasses)[number];

/** Append-only: a profile edit makes a new revision; an existing one never changes. */
export const agentProfileRevisions = pgTable(
  "agent_profile_revisions",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    agentProfileId: uuid("agent_profile_id").notNull(),
    revision: integer("revision").notNull(),
    /** sha256 of the canonical snapshot; identical content reuses a revision. */
    contentHash: text("content_hash").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    ...recordedBy,
  },
  (t) => [
    foreignKey({
      name: "agent_profile_revisions_profile_fk",
      columns: [t.workspaceId, t.agentProfileId],
      foreignColumns: [agentProfiles.workspaceId, agentProfiles.id],
    }).onDelete("cascade"),
    unique("agent_profile_revisions_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("agent_profile_revisions_profile_revision_key").on(t.agentProfileId, t.revision),
    unique("agent_profile_revisions_profile_hash_key").on(t.agentProfileId, t.contentHash),
  ],
);
