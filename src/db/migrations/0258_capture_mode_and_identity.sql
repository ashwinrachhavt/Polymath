-- Capture identity is mode-aware. A selection or page grab is one reading of a
-- URL and many may exist; a url-reference is the URL itself and may exist once.
-- The column lands nullable, history is backfilled by shape, and only then is
-- NOT NULL enforced and the unique index created: an existing database already
-- holds rows, and those rows already collide under the new rule.
--
-- CI and deploy apply one `psql -f` per file with no `-1`, so a failure partway
-- through commits the statements before it. Every statement below is therefore
-- safe to re-run: guarded types, IF EXISTS, IF NOT EXISTS, and an update that
-- only touches rows whose hash is still null.
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
-- a null one. Rows are grouped by their exact body, and only a genuine repeat
-- gets its id folded in; the earliest of each body keeps the plain hash, so a
-- re-capture still dedupes against it. A later duplicate gets a hash of its text
-- plus its own id: still a hash of what arrived, non-null, and unable to collide.
-- That ordering is what lets the index be created -- re-hashing a duplicate to
-- the survivor's hash would violate it, and nulling it would strand the row. A
-- row with an empty body hashes the empty string, so no url-bearing page or
-- selection row is left without a hash at all.
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
--
-- Two different readings of one URL (a page grab, then a selection) are not
-- duplicates and each gets the plain hash of its own text. Two identical bodies
-- at one identity are, and the later of them gets its own id folded in: the
-- unique index below forbids them sharing a hash, the CHECK below forbids them
-- being null, so a distinct hash is the only value that satisfies both. The
-- earliest row keeps the plain hash, so a re-capture of that text still dedupes
-- against it; the suffixed rows are historical duplicates being preserved, not
-- rows a future insert should ever match.
update captures c
   set content_hash = encode(sha256(convert_to(
         coalesce(c.text, c.clean_text, '')
           || case when r.rn = 1 then '' else '#' || c.id::text end,
         'UTF8')), 'hex')
  from (
    select id, row_number() over (
             partition by workspace_id, source, url, capture_mode,
                          encode(sha256(convert_to(coalesce(text, clean_text, ''), 'UTF8')), 'hex')
             order by created_at, id) as rn
      from captures
     where url is not null and capture_mode not in ('url-reference', 'blob')
  ) r
 where c.id = r.id and c.content_hash is null;--> statement-breakpoint
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
