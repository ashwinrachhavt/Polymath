import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import {
  NOTION_PAGE_APPEND,
  NOTION_PAGE_CREATE,
  proposeNotionPageUpdate,
} from "../../../../src/domains/knowledge/notion-proposals";

/*
 * ASH-283: propose a Notion page write the owner approves as a diff. The tool
 * never calls Notion. It records a proposal carrying the exact markdown and a
 * content hash, and the approval is what executes it — so the text in the
 * review card and the text in the page are the same bytes, and the owner sees
 * the addition before it exists.
 *
 * Append-or-create only. There is no edit-in-place mode: Notion exposes no
 * compare-and-swap on a block list, so a rewrite could silently clobber an edit
 * the owner made between proposal and approval.
 */
export default defineTool({
  description:
    "Propose adding content to a Notion page, or creating a new one, for the owner to approve. Use when the owner asks to save something to Notion, or when a finding belongs in a page they already keep there. Nothing reaches Notion until the owner approves the diff in the review queue. Appending is safe and reversible by deleting the blocks; do not use this to rewrite or reorganise an existing page, which this cannot do safely. Pass a stable dedupeId so a retry proposes once.",
  inputSchema: z.object({
    mode: z.enum(["append", "create"]).describe("append adds to an existing page; create makes a new one."),
    pageId: z.string().min(1).max(200).optional().describe("The Notion page id to append to. Required when mode is append; find it with notion_search."),
    parentId: z.string().min(1).max(200).optional().describe("The parent page or database id for a new page. Required when mode is create."),
    parentType: z.enum(["page", "database"]).optional().describe("What the parent is. Defaults to page."),
    title: z.string().min(1).max(300).describe("The page title to show the owner in the review card, and the new page's title when creating."),
    markdown: z
      .string()
      .min(1)
      .max(20_000)
      .describe("The exact content to add, as markdown. This is what the owner reviews and what is written; headings, lists, quotes and inline links are supported."),
    dedupeId: z.string().min(1).max(200).describe("Stable identifier for this write, so a retry resolves the same proposal instead of queuing a second."),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }
    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    const capability = input.mode === "append" ? NOTION_PAGE_APPEND : NOTION_PAGE_CREATE;
    if (!toolAllowed(run.policySnapshot, capability)) {
      return { ok: false as const, error: `${capability} is not in this run's policy snapshot` };
    }
    try {
      const result = await proposeNotionPageUpdate(
        { workspaceId, userId: current.principalId } as Parameters<typeof proposeNotionPageUpdate>[0],
        {
          mode: input.mode,
          ...(input.pageId ? { pageId: input.pageId } : {}),
          ...(input.parentId ? { parentId: input.parentId } : {}),
          ...(input.parentType ? { parentType: input.parentType } : {}),
          title: input.title,
          markdown: input.markdown,
          dedupeKey: `${run.id}:${input.dedupeId}`,
          runId: run.id,
        },
      );
      return {
        ok: true as const,
        proposalId: result.proposalId,
        deduplicated: result.deduplicated,
        contentHash: result.contentHash,
        status: "awaiting review",
      };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : "could not propose the Notion write" };
    }
  },
});
