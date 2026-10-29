-- 2026-10-29 rename: the first-party agent profile's machine-facing display
-- name moves from "alfred" to "polymath" (the eve mount rename ships in the
-- same deploy). agent_principals.key values are immutable and deliberately
-- untouched. Lineage is recorded in agent_profiles.metadata
-- ({ "renamedFrom": "alfred" }) so ensureProfile resolves the renamed row
-- even on the collision path.
--
-- Collision: a workspace where a person already named a profile "polymath"
-- while an "alfred" profile exists cannot take the plain rename (name is
-- unique per workspace). The alfred profile becomes "polymath-2"
-- ("polymath-3", ... if needed), the rename is audit-evented, and the deploy
-- never fails on user data.
ALTER TABLE "agent_profiles" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$
DECLARE
  r RECORD;
  candidate TEXT;
  n INT;
BEGIN
  FOR r IN SELECT id, workspace_id FROM "agent_profiles" WHERE name = 'alfred' LOOP
    IF EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p.workspace_id = r.workspace_id AND p.name = 'polymath') THEN
      n := 2;
      LOOP
        candidate := 'polymath-' || n;
        EXIT WHEN NOT EXISTS (SELECT 1 FROM "agent_profiles" p WHERE p.workspace_id = r.workspace_id AND p.name = candidate);
        n := n + 1;
      END LOOP;
      UPDATE "agent_profiles"
        SET name = candidate,
            metadata = COALESCE(metadata, '{}'::jsonb) || '{"renamedFrom":"alfred"}'::jsonb
        WHERE id = r.id;
      INSERT INTO "audit_events" ("workspace_id", "actor_kind", "action", "subject_type", "subject_id", "summary", "metadata")
        VALUES (r.workspace_id, 'system', 'agent_profile.rename_collision', 'agent_profile', r.id,
                'Renamed agent profile "alfred" to "' || candidate || '" because "polymath" was already taken.',
                jsonb_build_object('from', 'alfred', 'to', candidate, 'migration', '0260'));
    ELSE
      UPDATE "agent_profiles"
        SET name = 'polymath',
            metadata = COALESCE(metadata, '{}'::jsonb) || '{"renamedFrom":"alfred"}'::jsonb
        WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
