import { after } from "next/server";
import { runGenerationJob } from "./commands";

/**
 * Starts a just-accepted attempt once the response has gone, without waiting
 * for the outbox worker's next pass. The outbox event stays the guarantee:
 * if this process dies first, the worker runs the attempt instead, and the
 * claim in runGenerationJob keeps the two from both doing the work.
 */
export function kickGenerationJob(ref: { jobId: string; attempt: number }): void {
  const work = () =>
    runGenerationJob(ref).catch((cause: unknown) => {
      console.error("[generation-job] inline run could not start", ref.jobId, cause);
    });
  try {
    after(work);
  } catch {
    // Outside a request scope `after` throws; the work is the same either way.
    void work();
  }
}
