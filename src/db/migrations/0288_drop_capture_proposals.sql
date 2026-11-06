-- The capture proposal layer is gone (the owner asked for captures that
-- land in the Inbox with no approval step; enrichment writes its domain
-- classification straight to the capture row). Pending rows are discarded -
-- no backfill - and decided rows were already history. No CASCADE: an
-- unexpected dependent object should fail loudly, not vanish. IF EXISTS
-- matches the retirement-drop convention (0269/0285/0286/0287) so converge's
-- re-application is a no-op once the table and enums are gone.
DROP TABLE IF EXISTS "capture_proposals";
DROP TYPE IF EXISTS "public"."capture_proposal_kind";
DROP TYPE IF EXISTS "public"."capture_proposal_status";
