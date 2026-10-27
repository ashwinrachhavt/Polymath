-- Capture identity is mode-aware. A selection or page grab is one reading of a
-- URL and many may exist; a url-reference is the URL itself and may exist once.
-- The column lands nullable, history is backfilled by shape, and only then is
-- NOT NULL enforced and the unique index created: an existing database already
-- holds rows, and those rows already collide under the new rule.
--
-- CI and deploy apply one `psql -f` per file with no `-1`, so a failure partway
-- through commits the statements before it. Every statement below is therefore
-- safe to re-run: guarded types and constraint, IF EXISTS, IF NOT EXISTS, a
-- backfill that computes its target and writes only rows that differ, and a
-- VALIDATE that is a no-op once satisfied.
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
-- a null one: rank within each identity and write the plain hash to rank 1 and
-- the id-folded hash to every other row, in one statement. The earliest row
-- keeps the plain hash, so a re-capture still dedupes against it; later
-- duplicates stay non-null, distinct, and still a hash of what arrived. Nulling
-- them would satisfy the index alone but strand them under the CHECK, equal
-- hashes would violate the index, and assigning in two passes would collide
-- mid-flight on a database that already has the index. One ranked statement
-- never holds two equal hashes at one identity at any point. A row with an empty
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
--
-- Rank within each identity and assign both values in ONE statement. Residue is
-- then zero by construction: this subquery's predicate is the exact complement
-- of the CHECK added below, and coalesce(..., '') means the target is never
-- null, so every row the constraint could reject is written here.
--
-- The ranking arm defends states this migration can be run against, not ones
-- observed in production. A 0256 database cannot hold two rows at one identity
-- (captures_workspace_source_url_key was UNIQUE on workspace_id, source, url),
-- so on a real upgrade every partition holds one row and rank 1 is chosen every
-- time. What the rank>1 arm covers is a partially applied run -- CI applies one
-- psql -f per file with no -1 -- or a later relaxation of that index. It costs
-- nothing over a plain fill and removes the ordering hazard entirely: with a
-- plain fill, a duplicate holding NULL would be written the survivor's own hash
-- and the unique index would reject the statement halfway through.
--
-- `is distinct from` makes a re-run write nothing at all.
update captures c
   set content_hash = t.target
  from (
    select r.id, encode(sha256(convert_to(
             coalesce(r.text, r.clean_text, '')
               || case when r.rn = 1 then '' else '#' || r.id::text end,
             'UTF8')), 'hex') as target
      from (
        select id, text, clean_text, row_number() over (
                 partition by workspace_id, source, url, capture_mode
                 order by created_at, id) as rn
          from captures
         where url is not null and capture_mode not in ('url-reference', 'blob')
      ) r
  ) t
 where c.id = t.id
   and c.content_hash is distinct from t.target;--> statement-breakpoint
alter table captures alter column capture_mode set not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "captures_identity_key" ON "captures" USING btree ("workspace_id","source","url","capture_mode","content_hash") WHERE url is not null and capture_mode <> 'url-reference';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "captures_url_reference_key" ON "captures" USING btree ("workspace_id","source","url") WHERE url is not null and capture_mode = 'url-reference';--> statement-breakpoint
-- Uniqueness over a nullable column does not dedupe (btree is NULLS DISTINCT),
-- so a caller that forgot the hash would silently disable identity for that row.
-- The database refuses it. Validated, not NOT VALID: a NOT VALID check still
-- runs on every later UPDATE, so it would strand exactly the historical rows the
-- backfill above has already repaired. If any such row somehow survives, the ADD
-- fails and the migration rolls back instead of leaving an unwritable table.
-- Guarded like the types above, because a partial apply -- or an earlier cut of
-- this migration -- may already have added it.
DO $$ BEGIN
  ALTER TABLE "captures" ADD CONSTRAINT "captures_identity_hash_present"
    CHECK (url is null or capture_mode in ('url-reference', 'blob') or content_hash is not null);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
-- An earlier cut added it NOT VALID, which would leave it meeting every write
-- from now on but never proven over the rows it already guards. VALIDATE is a
-- no-op on an already-valid constraint, so this runs on both paths and both end
-- with a constraint that is both enforced and validated. It fails loudly if the
-- backfill above left a row the constraint would reject, rather than shipping a
-- table whose rows cannot be written.
ALTER TABLE "captures" VALIDATE CONSTRAINT "captures_identity_hash_present";
