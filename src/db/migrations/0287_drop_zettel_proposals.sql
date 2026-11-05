-- Direct creation (plan PRs 1–3) left zettel_proposals without a writer and
-- its read paths returning stale rows. This is a pure subtraction: pending
-- proposals are discarded (Pino's 2026-11-05 call — no backfill; accepted
-- proposals already have cards). No CASCADE: an unexpected dependent object
-- should fail loudly, not vanish. IF EXISTS matches the retirement-drop
-- convention (0269/0285/0286) so converge's re-application of the
-- retirement files is a no-op once the table and enum are gone.
DROP TABLE IF EXISTS "zettel_proposals";
DROP TYPE IF EXISTS "public"."zettel_proposal_status";
