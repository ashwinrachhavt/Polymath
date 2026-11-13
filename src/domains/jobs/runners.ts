import type { AuthContext } from "@/domains/identity/resolve";
import { NOTION_SYNC_KIND, notionSyncRunner } from "@/domains/integrations/notion-job";
import { zettelJobRunners } from "@/domains/capture/zettel-generation";
import { learningJobRunners } from "@/domains/learning/generation-jobs";
import { missionJobRunners } from "@/domains/learning/mission-jobs";
import { SITE_CRAWL_KIND, siteCrawlRunner } from "@/domains/knowledge/site-crawl";
import { YOUTUBE_ABSORB_KIND, youtubeAbsorbRunner } from "@/domains/knowledge/youtube-absorb";
import type { GenerationJobResult } from "./schema";

/** What a runner is handed besides its input. */
export type GenerationJobRun = {
  /** Unique to this attempt: pass it wherever the work takes an idempotency key, so a redelivered run writes once. */
  generationKey: string;
  /** Aborts once the job is cancelled. Pass it to long provider calls; check it between steps. */
  signal: AbortSignal;
  /**
   * Says what the run is doing, e.g. ("Crawling", { done: 12, total: 25 }).
   * The jobs stream carries it to the maker's open tabs. Throws
   * GenerationJobCancelled once the job was cancelled; let it propagate.
   */
  progress(step: string, counts?: { done: number; total?: number }): Promise<void>;
};

/**
 * Does one job's work as its maker and says where the result lives.
 *
 * `input` is the stored jsonb, so the runner parses it. Throw
 * GenerationJobFailure to fail with copy the person can read.
 */
export type GenerationJobRunner = (
  auth: AuthContext,
  input: unknown,
  run: GenerationJobRun,
) => Promise<GenerationJobResult>;

/** Every kind of generation job and the runner that does it. A new kind is one entry here. */
export function generationJobRunners(): Record<string, GenerationJobRunner> {
  return {
    ...learningJobRunners,
    ...missionJobRunners,
    ...zettelJobRunners,
    [SITE_CRAWL_KIND]: siteCrawlRunner(),
    [YOUTUBE_ABSORB_KIND]: youtubeAbsorbRunner(),
    [NOTION_SYNC_KIND]: notionSyncRunner,
  };
}
