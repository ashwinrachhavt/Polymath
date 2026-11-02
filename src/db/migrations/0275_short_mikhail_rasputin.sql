ALTER TABLE "work_outbox_receipts" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "work_outbox_receipts" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "work_outbox_receipts" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "work_outbox_receipts_lease_expiry_idx" ON "work_outbox_receipts" USING btree ("lease_expires_at") WHERE "work_outbox_receipts"."lease_owner" is not null and "work_outbox_receipts"."status" = 'pending';