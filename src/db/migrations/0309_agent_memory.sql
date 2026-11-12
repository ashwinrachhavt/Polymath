CREATE TABLE "memory_dreams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"checked_through" timestamp with time zone,
	"last_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "memory_dreams_owner_key" UNIQUE("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "memory_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'unconfirmed' NOT NULL,
	"key" text NOT NULL,
	"source_kind" text DEFAULT 'run' NOT NULL,
	"source_id" uuid,
	"source_quote" text,
	"previous_body" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "memory_notes_owner_key" UNIQUE("workspace_id","user_id","key"),
	CONSTRAINT "memory_notes_body_check" CHECK (char_length(btrim(body)) between 1 and 400)
);
--> statement-breakpoint
ALTER TABLE "memory_dreams" ADD CONSTRAINT "memory_dreams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_dreams" ADD CONSTRAINT "memory_dreams_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_notes" ADD CONSTRAINT "memory_notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_notes" ADD CONSTRAINT "memory_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_notes_owner_status_idx" ON "memory_notes" USING btree ("workspace_id","user_id","status","updated_at");