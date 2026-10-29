/*
 * Next.js startup hook. The creation-run stranded sweep (plan §16.1) runs
 * once per process start: an in-process run whose originating connection
 * died mid-flight is failed with a stage_failed outcome, so a reconnect
 * replays a finished record instead of waiting on a live stream that will
 * never come.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.DATABASE_URL) return;
  const { sweepStrandedCreationRuns } = await import("@/domains/knowledge/sitting-run");
  await sweepStrandedCreationRuns().catch(() => {
    // A failed sweep never blocks boot; the next start retries it.
  });
}
