-- 0210 (ASH-174 / ASH-184): a zettel is a first-class artifact. Accepting a
-- zettel proposal creates the card in the same versioned container notes use,
-- and the link graph learns why each edge exists (`link_type`, with `context`
-- and `score` for the semantic edges that arrive in 0211).
ALTER TYPE "public"."artifact_kind" ADD VALUE 'zettel';--> statement-breakpoint
ALTER TABLE "artifact_links" ADD COLUMN "link_type" text DEFAULT 'reference' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_links" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "artifact_links" ADD COLUMN "score" real;--> statement-breakpoint
ALTER TABLE "artifact_links" DROP CONSTRAINT "artifact_links_target_type_check";--> statement-breakpoint
ALTER TABLE "artifact_links" ADD CONSTRAINT "artifact_links_target_type_check" CHECK (target_type in ('task', 'project', 'space', 'note', 'artifact', 'document', 'source', 'event', 'contact', 'company', 'person', 'organization', 'opportunity', 'run', 'thread', 'zettel'));--> statement-breakpoint
ALTER TABLE "artifact_links" ADD CONSTRAINT "artifact_links_link_type_check" CHECK (link_type in ('reference', 'related', 'supports', 'contradicts', 'source', 'semantic'));--> statement-breakpoint
ALTER TABLE "zettel_proposals" ADD COLUMN "artifact_id" uuid;--> statement-breakpoint
ALTER TABLE "zettel_proposals" ADD CONSTRAINT "zettel_proposals_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;
