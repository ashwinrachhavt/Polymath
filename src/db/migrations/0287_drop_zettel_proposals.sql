-- Direct creation (plan PRs 1–3) left zettel_proposals without a writer and
-- its read paths returning stale rows. This is a pure subtraction: pending
-- proposals are discarded (Pino's 2026-11-05 call — no backfill; accepted
-- proposals already have cards). No CASCADE: an unexpected dependent object
-- should fail loudly, not vanish.
DROP TABLE "zettel_proposals";
DROP TYPE "public"."zettel_proposal_status";
