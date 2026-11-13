import { z } from "zod";
import type { GenerationJobRunner } from "@/domains/jobs/runners";
import { GenerationJobFailure } from "@/domains/jobs/state";
import { NotionImportError, summarizeNotionSync, syncNotionAccount } from "./notion";

/*
 * A Notion sync as a background job: a tree of 40 pages takes minutes, so it
 * runs in the jobs system (progress in the jobs panel, cancellable) instead of
 * inside a server action. The sync itself is `syncNotionAccount`; this is only
 * its job kind. A cancelled job stops between pages, and the pages already
 * imported stay (every page is idempotent by content hash).
 */

export const NOTION_SYNC_KIND = "integrations.notion";

const inputSchema = z.object({
  externalAccountId: z.uuid(),
  /** A Notion page link or id; omitted, the sync reads every page the connection can see. */
  rootPageId: z.string().min(1).max(500).optional(),
});

type NotionSyncInput = z.infer<typeof inputSchema>;

/** The job for one account and root. The key repeats within 15 seconds, so a double click joins the first job. */
export function notionSyncJob(input: NotionSyncInput, now: Date = new Date()) {
  const scope = input.rootPageId?.replace(/[^0-9a-f]/gi, "").toLowerCase() || "all";
  return {
    kind: NOTION_SYNC_KIND,
    subject: `integration:${input.externalAccountId}`,
    idempotencyKey: `notion-sync:${input.externalAccountId}:${scope}:${Math.floor(now.getTime() / 15_000)}`,
    title: "Importing from Notion",
    input,
  };
}

export const notionSyncRunner: GenerationJobRunner = async (auth, raw, run) => {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new Error("malformed notion sync input");
  try {
    await run.progress("Connecting to Notion");
    const result = await syncNotionAccount(auth, {
      ...parsed.data,
      progress: (step, counts) => run.progress(step, counts),
    });
    return { href: "/command-center/integrations", notice: summarizeNotionSync(result) };
  } catch (cause) {
    if (cause instanceof NotionImportError) throw new GenerationJobFailure(cause.message);
    throw cause;
  }
};
