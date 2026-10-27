-- Capture identity is mode-aware. A selection or page grab is one reading of a
-- URL and many may exist; a url-reference is the URL itself and may exist once.
-- The column lands nullable, history is backfilled by shape, and only then is
-- NOT NULL enforced and the unique index created: an existing database already
-- holds rows, and those rows already collide under the new rule.
--
-- CI and deploy apply one `psql -f` per file with no `-1`, so a failure partway
-- through commits the statements before it. Every statement below is therefore
-- safe to re-run: guarded types and constraint, IF EXISTS, IF NOT EXISTS, one
-- update that only fills a null hash, and one that only changes a hash an
-- earlier row already holds.
--
-- Order is load-bearing, and it is not the obvious one.
--
-- The unique index and the CHECK below both constrain content_hash, but they are
-- not independent: the index forbids two rows sharing an identity AND a hash,
-- while the CHECK forbids a url-bearing page or selection row having no hash.
-- For two exact duplicates that leaves no null to hide in. Nulling the later
-- duplicate satisfies the index (btree is NULLS DISTINCT) but then the CHECK
-- rejects that row, and a CHECK -- even a NOT VALID one, which only skips the
-- initial scan -- is re-evaluated on every later UPDATE. Such a row could never
-- be written again: enrichment, parking, and conversion all update captures.
--
-- So duplicates are resolved by giving the later row a distinct hash rather than
-- a null one: fill every hash from the arriving text, then fold the row's id
-- into any hash an earlier row at the same identity already holds. The earliest
-- row keeps the plain hash, so a re-capture still dedupes against it; later
-- duplicates stay non-null, distinct, and still a hash of what arrived. Nulling
-- them would satisfy the index alone but strand them under the CHECK, and
-- re-hashing them to the survivor's value would violate the index -- the
-- two-pass fill-then-disambiguate is what satisfies both. A row with an empty
-- body hashes the empty string, so no url-bearing page or selection row is left
-- without a hash at all.
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
-- Hash the arriving text, not the normalized clean_text: contentHash() hashes its
-- argument unmapped, so hashing clean_text (soft hyphens stripped, CRLF and blank
-- lines collapsed) would give historical rows a different hash than the same
-- capture yields today, and re-capturing one would insert a duplicate instead of
-- colliding. clean_text is the fallback for a row with no text; an empty body
-- hashes the empty string rather than staying null.
update captures c
   set content_hash = encode(sha256(convert_to(coalesce(c.text, c.clean_text, ''), 'UTF8')), 'hex')
 where c.url is not null and c.capture_mode not in ('url-reference', 'blob')
   and c.content_hash is null;--> statement-breakpoint
-- Then break ties. Two readings of one URL with different bodies (a page grab,
-- then a selection) are not duplicates and keep the plain hash of their own text.
-- Two identical bodies at one identity are, and the unique index below forbids
-- them sharing a hash while the CHECK forbids them being null, so the later one
-- gets its id folded into its hash: still a hash of what arrived, non-null, and
-- unable to collide. The earliest keeps the plain hash, so a re-capture of that
-- text still dedupes against it. This runs as a separate pass, after the fill,
-- because a database left behind by the earlier null-dedupe already holds a
-- plain hash on a later row; deciding by rank during the fill would then hand
-- the plain hash to the earliest row and collide with it.
update captures c
   set content_hash = encode(sha256(convert_to(coalesce(c.text, c.clean_text, '') || '#' || c.id::text, 'UTF8')), 'hex')
 where c.content_hash is not null and exists (
   select 1 from captures d
    where d.workspace_id = c.workspace_id and d.source = c.source
      and d.url = c.url and d.capture_mode = c.capture_mode
      and d.content_hash = c.content_hash
      and (d.created_at, d.id) < (c.created_at, c.id));--> statement-breakpoint
alter table captures alter column capture_mode set not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "captures_identity_key" ON "captures" USING btree ("workspace_id","source","url","capture_mode","content_hash") WHERE url is not null and capture_mode <> 'url-reference';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "captures_url_reference_key" ON "captures" USING btree ("workspace_id","source","url") WHERE url is not null and capture_mode = 'url-reference';--> statement-breakpoint
-- Uniqueness over a nullable column does not dedupe (btree is NULLS DISTINCT),
-- so a caller that forgot the hash would silently disable identity for that row.
-- The database refuses it. Validated, not NOT VALID: a NOT VALID check still
-- runs on every later UPDATE, so it would strand exactly the historical rows the
-- backfill above has already repaired. If any such row somehow survives, the ADD
-- fails and the migration rolls back instead of leaving an unwritable table.
-- Guarded like the types above, because a partial apply may already have added it.
DO $$ BEGIN
  ALTER TABLE "captures" ADD CONSTRAINT "captures_identity_hash_present"
    CHECK (url is null or capture_mode in ('url-reference', 'blob') or content_hash is not null);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
