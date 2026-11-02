-- 0271: backfill the completion sweep for pre-#410 rows. 0267's sweep discards
-- only FAILED interview runs at completion, so a hung or stale-running
-- interview from an earlier build kept rendering in the home conversation
-- list, titled with the raw interview script — and an earlier script
-- revision's text ("use \"Alfred\"") also slipped past the exclusion, which
-- matched only today's constant. Retire every onboarding interview run that
-- never completed, whatever its state or age, by the script's stable first
-- line. Rows are marked, not deleted: run_events, steps, and tool calls
-- survive for audit.
update agent_runs
set discarded_at = now()
where objective like 'onboarding-interview%'
  and state <> 'succeeded'
  and discarded_at is null;
