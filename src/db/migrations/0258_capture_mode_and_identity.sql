-- Capture identity is mode-aware. A selection or page grab is one reading of a
-- URL and many may exist; a url-reference is the URL itself and may exist once.
-- The column lands nullable, history is backfilled by shape, and only then is
-- NOT NULL enforced and the unique index created: an existing database already
-- holds rows, and those rows already collide under the new rule.
--
-- CI and deploy apply one `psql -f` per file with no `-1`, so a failure partway
-- through commits the statements before it. Every statement below is therefore
-- safe to re-run: guarded types, IF EXISTS, IF NOT EXISTS, and idempotent
-- updates. A retry after a partial apply must leave the table usable.
DO $$ BEGIN
  CREATE TYPE "public"."capture_fetch_outcome" AS ENUM('pending', 'acquired', 'error-page', 'access-denied', 'empty', 'provider-unavailable');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."capture_mode" AS ENUM('authored', 'selection', 'page', 'url-reference', 'blob');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "captures_workspace_source_url_key";--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN IF NOT EXISTS "capture_mode" "capture_mode";--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN IF NOT EXISTS "fetched_text" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN IF NOT EXISTS "content_hash" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN IF NOT EXISTS "fetch_outcome" "capture_fetch_outcome";--> statement-breakpoint
update captures set capture_mode = case
  when kind = 'url' then 'url-reference'::capture_mode
  when kind = 'text' and url is not null then 'page'::capture_mode
  when kind = 'text' then 'authored'::capture_mode
  else 'blob'::capture_mode end
 where capture_mode is null;--> statement-breakpoint
-- Hash the arriving text, not the normalized clean_text: contentHash() hashes
-- its argument unmapped, so hashing clean_text (soft hyphens stripped, CRLF and
-- blank lines collapsed) would give historical rows a different hash than the
-- same capture yields today, and re-capturing one would insert a duplicate
-- instead of colliding. clean_text is only a fallback for rows with no text.
-- The `not exists` keeps a re-run from re-hashing a row the dedupe below
-- deliberately nulled, which the unique index would then reject.
update captures c
   set content_hash = encode(sha256(convert_to(coalesce(c.text, c.clean_text), 'UTF8')), 'hex')
 where c.url is not null and c.capture_mode not in ('url-reference', 'blob')
   and coalesce(c.text, c.clean_text) is not null
   and c.content_hash is null
   and not exists (
     select 1 from captures d
      where d.workspace_id = c.workspace_id and d.source = c.source
        and d.url = c.url and d.capture_mode = c.capture_mode
        and d.content_hash is not null
        and (d.created_at, d.id) < (c.created_at, c.id));--> statement-breakpoint
-- Existing rows may already collide under the new rule. Keep the earliest and
-- null the rest, so the unique index can be created; a null hash does not dedupe.
update captures c set content_hash = null
 where c.content_hash is not null and exists (
   select 1 from captures d
    where d.workspace_id = c.workspace_id and d.source = c.source
      and d.url = c.url and d.capture_mode = c.capture_mode
      and d.content_hash = c.content_hash
      and (d.created_at, d.id) < (c.created_at, c.id));--> statement-breakpoint
alter table captures alter column capture_mode set not null;--> statement-breakpoint
-- Uniqueness over a nullable column does not dedupe (btree is NULLS DISTINCT),
-- so a caller that forgot the hash would silently disable identity for that
-- row. The database refuses it. NOT VALID because the dedupe above leaves
-- historical duplicates with no hash on purpose; every future insert and update
-- is checked, and a later repair can VALIDATE once those rows are reconciled.
DO $$ BEGIN
  ALTER TABLE "captures" ADD CONSTRAINT "captures_identity_hash_present"
    CHECK (url is null or capture_mode in ('url-reference', 'blob') or content_hash is not null) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "captures_identity_key" ON "captures" USING btree ("workspace_id","source","url","capture_mode","content_hash") WHERE url is not null and capture_mode <> 'url-reference';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "captures_url_reference_key" ON "captures" USING btree ("workspace_id","source","url") WHERE url is not null and capture_mode = 'url-reference';
