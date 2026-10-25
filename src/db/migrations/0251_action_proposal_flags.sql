-- 0251: ASH-281 display-only injection flags on action proposals. The Writer
-- draft path quotes action requests it found inside untrusted thread text;
-- they annotate the review card and are never queried, sorted, or enforced
-- on. Hand-written: drizzle-kit generate cannot run against the broken
-- snapshot chain (see 0250's header / ASH-316); check-migrations guards the
-- journal entry.
ALTER TABLE "action_proposals" ADD COLUMN "flags" jsonb;
