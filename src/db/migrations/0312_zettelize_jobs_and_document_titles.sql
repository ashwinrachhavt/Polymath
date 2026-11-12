-- Data only: no schema change.
--
-- 1. Zettelize moved from its own outbox topic to generation jobs. A pending
--    "capture.zettels_requested" row would never be handled again (a topic
--    with no handler is parked and re-parked forever), so each one becomes a
--    queued "zettels.source" job made for the workspace's first active owner -
--    the actor the old handler ran as - with its run event, and the old row
--    is removed. Settled rows (dispatched, failed) are history and stay.
WITH pending AS (
  SELECT o.id AS outbox_id, o.workspace_id, o.payload ->> 'captureId' AS capture_id
  FROM outbox_events o
  WHERE o.topic = 'capture.zettels_requested'
    AND o.status = 'pending'
    AND (o.payload ->> 'captureId') ~ '^[0-9a-fA-F-]{36}$'
),
owners AS (
  SELECT DISTINCT ON (m.workspace_id) m.workspace_id, m.user_id
  FROM memberships m
  WHERE m.role = 'owner' AND m.status = 'active'
  ORDER BY m.workspace_id, m.created_at
),
jobs AS (
  INSERT INTO generation_jobs (workspace_id, kind, idempotency_key, subject, title, input, created_by)
  SELECT
    p.workspace_id,
    'zettels.source',
    'migrated-outbox:' || p.outbox_id,
    'capture:' || p.capture_id,
    'Ideas: ' || coalesce(nullif(left(btrim(regexp_replace(c.title, '^[\s>#]+', '')), 60), ''), 'a capture'),
    jsonb_build_object('source', jsonb_build_object('kind', 'capture', 'id', p.capture_id)),
    w.user_id
  FROM pending p
  JOIN owners w ON w.workspace_id = p.workspace_id
  LEFT JOIN captures c ON c.id = p.capture_id::uuid AND c.workspace_id = p.workspace_id
  ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
  RETURNING id, workspace_id
)
INSERT INTO outbox_events (workspace_id, topic, payload, dispatch_key)
SELECT j.workspace_id, 'generation.job_requested', jsonb_build_object('jobId', j.id, 'attempt', 1), j.id || ':1'
FROM jobs j;
--> statement-breakpoint
DELETE FROM outbox_events WHERE topic = 'capture.zettels_requested' AND status = 'pending';
--> statement-breakpoint
-- 2. Document titles saved as raw markdown ("> ## Documentation Index", from a
--    docs page whose first line is a quoted site notice). The document's own
--    level-one heading names it; without one, the markup is stripped.
UPDATE documents d
SET title = left(
      coalesce(
        nullif(btrim(regexp_replace(
          (
            SELECT substring(de.text FROM '(?n)^#[ \t]+([^\r\n]+)')
            FROM document_extractions de
            WHERE de.document_id = d.id AND de.status = 'succeeded'
            ORDER BY de.created_at DESC
            LIMIT 1
          ),
          '[*_`]|[ \t]#+[ \t]*$', '', 'g')), ''),
        nullif(btrim(regexp_replace(d.title, '^[\s>#]+', '')), ''),
        d.title
      ),
      200
    ),
    version = d.version + 1
WHERE d.title ~ '^\s*[>#]';
