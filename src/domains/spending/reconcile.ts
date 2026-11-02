import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/*
 * The stuck-reservation reconciler (PR-5, the reconciler half of the fail-loud
 * durability decision). A reservation is the budget claim that makes the
 * ceilings hold, so an open one nothing will ever settle is a ghost: it
 * haunts the open list and holds budget forever. `expired` has been in the
 * status enum from the start; this job is the first thing that writes it.
 *
 * The reconciler expires, never settles: a stale claim's true cost is
 * unknowable here, and settling on a guess is how a ledger learns to lie.
 * The dates it checks are `created_at` (the claim's age) and the linked run's
 * state; the `status = 'reserved'` predicate in the UPDATE is the idempotency
 * guard, so a close racing this job cannot double-write — whichever lands
 * first wins and the other matches no row.
 */

/** An open reservation this old whose run is already terminal is a close that failed mid-flight. */
const GHOST_MIN_AGE_SECONDS = 60 * 60;

/** Hard cap: no open reservation outlives this, however long its run parks. */
const MAX_OPEN_AGE_DAYS = 30;

const TERMINAL_RUN_STATES = ["succeeded", "failed", "cancelled"];

/**
 * Expires stale open reservations: terminal-run ghosts older than an hour (a
 * healthy close settles in the same transaction as the terminal state flip,
 * so an hour of openness means its settle never ran), reservations whose run
 * row has vanished, and any open reservation past the hard cap. Returns how
 * many rows it expired.
 */
export async function expireStaleReservations(): Promise<{ expired: number }> {
  const rows = (await db.execute(sql`
    with stale as (
      select r.id
      from spending_reservations r
      left join agent_runs a on a.id = r.run_id
      where r.status = 'reserved'
        and (
          r.created_at < now() - make_interval(days => ${MAX_OPEN_AGE_DAYS})
          or (
            r.created_at < now() - make_interval(secs => ${GHOST_MIN_AGE_SECONDS})
            and (
              a.id is null
              or a.state::text in (${sql.join(
                TERMINAL_RUN_STATES.map((s) => sql`${s}`),
                sql`, `,
              )})
            )
          )
        )
    )
    update spending_reservations s
    set status = 'expired', expires_at = now(), updated_at = now(), version = s.version + 1
    from stale
    where s.id = stale.id and s.status = 'reserved'
    returning s.id
  `)) as unknown as { id: string }[];
  return { expired: rows.length };
}
