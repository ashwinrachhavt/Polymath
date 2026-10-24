-- 0237 (daybook pins): the day page is a view; pins are its only persisted
-- state (eng review D8). Deriving "created/worked on/captured" needs two
-- indexes no existing one serves: artifacts had only (workspace_id, kind,
-- updated_at), and captures' only (workspace_id, created_at) index is partial
-- on unprocessed states, so every past-day render seq-scanned processed
-- captures.
--
-- day_artifact_pins pins an artifact (optionally an exact version) to a
-- local date. The composite FK (pinned_version_id, artifact_id) ->
-- artifact_versions (id, artifact_id) makes a cross-artifact version pin
-- impossible at the row level; the unique index it references must exist
-- first, so it leads this file. artifact_id RESTRICTs so a pinned record
-- cannot vanish from its day.
CREATE UNIQUE INDEX "artifact_versions_id_artifact_id_key" ON "artifact_versions" USING btree ("id","artifact_id");--> statement-breakpoint
CREATE TABLE "day_artifact_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"artifact_id" uuid NOT NULL,
	"pinned_version_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "day_artifact_pins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
	CONSTRAINT "day_artifact_pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE,
	CONSTRAINT "day_artifact_pins_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE RESTRICT,
	CONSTRAINT "day_artifact_pins_version_artifact_fk" FOREIGN KEY ("pinned_version_id", "artifact_id") REFERENCES "public"."artifact_versions"("id", "artifact_id")
);
--> statement-breakpoint
CREATE INDEX "day_artifact_pins_day_idx" ON "day_artifact_pins" USING btree ("workspace_id","user_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "day_artifact_pins_day_key" ON "day_artifact_pins" USING btree ("workspace_id","user_id","local_date","artifact_id");--> statement-breakpoint
CREATE INDEX "artifacts_workspace_created_idx" ON "artifacts" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "captures_workspace_created_idx" ON "captures" USING btree ("workspace_id","created_at");
