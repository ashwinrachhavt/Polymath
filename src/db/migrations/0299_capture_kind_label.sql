ALTER TABLE "captures" ADD COLUMN "kind_label" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "kind_reason" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "kind_source" text;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_kind_label_known" CHECK (kind_label is null or kind_label in ('article', 'idea', 'task', 'person', 'reference', 'quote', 'other'));--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_kind_source_known" CHECK ((kind_label is null) = (kind_source is null) and (kind_source is null or kind_source in ('rules', 'jev', 'user')));