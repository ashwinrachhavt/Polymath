-- Capture identity is mode-aware. A selection or page grab is one reading of a
-- URL and many may exist; a url-reference is the URL itself and may exist once.
--
-- Rolling-deploy safe in BOTH directions. Deploys do not run migrations, so the
-- order is: apply this file, then deploy. The code running during that gap is
-- the OLD code, which inserts captures without capture_mode or content_hash. A
-- BEFORE INSERT/UPDATE trigger fills both from the row's shape, using the same
-- rules as inferCaptureMode() and contentHash() in src/domains/capture/mode.ts,
-- so NOT NULL, the CHECK and the identity indexes hold for old writers too.
-- Rolling the app back after the deploy is safe for the same reason. New code
-- always supplies both values, so the trigger never fires for it. A follow-up
-- migration drops the trigger once no old build can run (see 0259 plan).
--
-- CI and deploy apply one `psql -f` per file with no `-1`, so a failure partway
-- through commits the statements before it. Every statement is safe to re-run.
--
-- Order is load-bearing:
--   1. additive only: types, nullable columns (old code is unaffected)
--   2. trigger, BEFORE any backfill, so a row inserted during the backfill is
--      filled by the trigger and a row inserted before it is filled by the
--      backfill: no row is missed
--   3. backfill, then NOT NULL via a validated CHECK (no long scan under lock)
--   4. create the finer identity indexes
--   5. drop the old (workspace, source, url) unique index LAST. Until that
--      statement, every row is still covered by the old rule, so duplicates
--      cannot exist at any earlier step and no ranking or dedupe pass is needed.
--      After it, the finer indexes already hold.
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
ALTER TABLE "captures" ADD COLUMN IF NOT EXISTS "capture_mode" "capture_mode";--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN IF NOT EXISTS "fetched_text" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN IF NOT EXISTS "content_hash" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN IF NOT EXISTS "fetch_outcome" "capture_fetch_outcome";--> statement-breakpoint
-- Mirrors how the two builds write rows, not a fresh guess: file and voice are
-- blobs; kind 'url' with an address is the address itself (url-reference), even
-- when the OLD url handler later filled text with the fetched reading, because
-- a url-reference is identified by its address, not its text; no url is
-- authored (a bare address typed as kind 'text' with no url is not produced by
-- either build, and a url-reference needs a url, so it stays authored); any
-- other row with a url is a page grab if it has text, else url-reference.
-- The hash is of the ARRIVING text, unmapped, exactly what contentHash() gets at
-- insert: raw_payload.text (immutable, written trimmed by both builds), else
-- text, else clean_text, else ''. text alone is wrong for historical rows: an
-- owner edit or the old fetch rewrote it after arrival. Blob and url-reference
-- keep a null hash on purpose.
CREATE OR REPLACE FUNCTION captures_compat_fill() RETURNS trigger AS $fn$
BEGIN
  IF NEW.capture_mode IS NULL THEN
    NEW.capture_mode := CASE
      WHEN NEW.kind IN ('file', 'voice') THEN 'blob'::capture_mode
      WHEN NEW.url IS NULL THEN 'authored'::capture_mode
      WHEN NEW.kind = 'url' THEN 'url-reference'::capture_mode
      WHEN nullif(btrim(NEW.text), '') IS NULL THEN 'url-reference'::capture_mode
      ELSE 'page'::capture_mode
    END;
  END IF;
  IF NEW.content_hash IS NULL AND NEW.url IS NOT NULL AND NEW.capture_mode NOT IN ('url-reference', 'blob') THEN
    NEW.content_hash := encode(sha256(convert_to(coalesce(nullif(NEW.raw_payload ->> 'text', ''), NEW.text, NEW.clean_text, ''), 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS captures_compat_fill_trg ON "captures";--> statement-breakpoint
CREATE TRIGGER captures_compat_fill_trg BEFORE INSERT OR UPDATE ON "captures"
  FOR EACH ROW EXECUTE FUNCTION captures_compat_fill();--> statement-breakpoint
-- Backfill through the trigger's own rules: a no-op write fires it, and the
-- predicate selects only rows it would change, so a re-run writes nothing.
UPDATE "captures" SET "capture_mode" = "capture_mode"
 WHERE "capture_mode" IS NULL
    OR ("content_hash" IS NULL AND "url" IS NOT NULL AND "capture_mode" NOT IN ('url-reference', 'blob'));--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "captures" ADD CONSTRAINT "captures_capture_mode_present" CHECK ("capture_mode" IS NOT NULL) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "captures" VALIDATE CONSTRAINT "captures_capture_mode_present";--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "capture_mode" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" DROP CONSTRAINT IF EXISTS "captures_capture_mode_present";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "captures_identity_key" ON "captures" USING btree ("workspace_id","source","url","capture_mode","content_hash") WHERE url is not null and capture_mode <> 'url-reference';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "captures_url_reference_key" ON "captures" USING btree ("workspace_id","source","url") WHERE url is not null and capture_mode = 'url-reference';--> statement-breakpoint
-- Uniqueness over a nullable column does not dedupe (btree is NULLS DISTINCT),
-- so a row with no hash would silently opt out of identity. The trigger
-- guarantees a hash; the database also refuses its absence. Added NOT VALID so
-- it takes effect for every write at once, then validated over existing rows.
DO $$ BEGIN
  ALTER TABLE "captures" ADD CONSTRAINT "captures_identity_hash_present"
    CHECK (url is null or capture_mode in ('url-reference', 'blob') or content_hash is not null) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "captures" VALIDATE CONSTRAINT "captures_identity_hash_present";--> statement-breakpoint
DROP INDEX IF EXISTS "captures_workspace_source_url_key";
