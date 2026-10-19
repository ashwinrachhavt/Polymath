-- Q03 (ASH-134): the outbox gains a dispatch identity and a lease. The
-- dispatch key lets a producer make "publish this intent" idempotent; the
-- lease (owner + token + expiry) lets a dispatcher claim rows without a
-- transaction spanning provider I/O, and makes a stale completion from a
-- dead worker a rejected write instead of a double effect. Additive.
ALTER TABLE "outbox_events" ADD COLUMN "dispatch_key" text;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_dispatch_key" ON "outbox_events" USING btree ("workspace_id","topic","dispatch_key") WHERE dispatch_key is not null;--> statement-breakpoint
CREATE INDEX "outbox_events_lease_expiry_idx" ON "outbox_events" USING btree ("lease_expires_at") WHERE lease_owner is not null and status = 'pending';
