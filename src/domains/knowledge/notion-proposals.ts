import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { actionProposals, actionRevisions } from "@/domains/actions/schema";
import { createProposal, senderAccountPin } from "@/domains/actions/commands";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import {
  composioNotionClient,
  composioNotionWriteClient,
  type NotionWriteClient,
} from "@/integrations/notion/client";

/*
 * ASH-283: a Notion page write as a proposal the owner approves as a diff.
 *
 * Two decisions worth naming.
 *
 * The content hash is over the exact markdown that will be written. Approval
 * binds to the revision row, and the revision carries that hash, so the thing
 * executed is byte-identical to the thing previewed. If the page changed under
 * us between proposal and approval, the append still lands — Notion has no
 * compare-and-swap on a block list — which is why the effect is append-only:
 * appending cannot clobber an edit the owner made, and the worst case is
 * duplication, which the owner can see and delete. Rewriting a page in place
 * would need a version check we cannot get, so this path does not offer it.
 *
 * Writes are external, so this is `external_write`: an owner decides, and the
 * executor is the only thing that touches Notion.
 */

export const NOTION_PAGE_APPEND = "notion.page.append";
export const NOTION_PAGE_CREATE = "notion.page.create";

export type NotionPagePayload = {
  mode: "append" | "create";
  /** Present for append. */
  pageId?: string;
  /** Present for create. */
  parentId?: string;
  parentType?: "page" | "database";
  title: string;
  markdown: string;
  /** sha256 of `markdown`, so the approved text is provably the written text. */
  contentHash: string;
  /** The page's markdown before the write, when the caller had it. Small, for the diff preview. */
  before?: string;
};

export class NotionProposalError extends Error {
  constructor(
    public readonly code: "empty_content" | "notion_unavailable" | "page_not_found",
    message: string,
  ) {
    super(message);
    this.name = "NotionProposalError";
  }
}

export function contentHash(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

/**
 * A line-level diff for the review card. The card shows what will be added,
 * so a `+` prefix on the new lines is enough — a full diff algorithm would
 * suggest a merge that this path cannot perform (it only appends).
 */
/**
 * The editor's dedupe key: one open proposal per note, page and exact text.
 * Unchanged content resolves the open proposal; an edited note proposes again
 * instead of resolving to a diff of the old text.
 */
export function noteNotionDedupeKey(noteId: string, pageId: string, markdown: string): string {
  return `note-notion:${noteId}:${pageId}:${contentHash(markdown).slice(0, 16)}`;
}

export function appendPreview(before: string, addition: string): string {
  const beforeLines = before.trimEnd().split("\n").filter((line) => line.trim());
  const additionLines = addition.trimEnd().split("\n");
  const tail = beforeLines.slice(-3);
  return [
    ...tail.map((line) => ` ${line}`),
    ...(tail.length > 0 ? ["  …"] : []),
    ...additionLines.map((line) => `+${line}`),
  ].join("\n");
}

export type ProposeNotionPageInput = {
  mode: "append" | "create";
  pageId?: string;
  parentId?: string;
  parentType?: "page" | "database";
  title: string;
  markdown: string;
  dedupeKey: string;
  runId?: string | null;
  /** The connected Notion account alias the write is pinned to. */
  accountAlias?: string | null;
  /** Read dependencies, so a test never needs a live account. */
  readClient?: { getPageMarkdown(pageId: string): Promise<string> };
};

export async function proposeNotionPageUpdate(
  auth: AuthContext,
  input: ProposeNotionPageInput,
): Promise<{ proposalId: string; deduplicated: boolean; contentHash: string }> {
  const markdown = input.markdown.trim();
  if (!markdown) throw new NotionProposalError("empty_content", "There is nothing to write.");
  if (input.mode === "append" && !input.pageId) {
    throw new NotionProposalError("page_not_found", "Appending needs a page.");
  }
  if (input.mode === "create" && !input.parentId) {
    throw new NotionProposalError("page_not_found", "Creating needs a parent page or database.");
  }

  // The "before" is best-effort: a page we cannot read still gets a proposal,
  // it just previews as an addition with no context above it. Failing the whole
  // proposal because the read failed would make a transient Notion error look
  // like an unusable request.
  let before = "";
  if (input.mode === "append" && input.readClient) {
    try {
      before = await input.readClient.getPageMarkdown(input.pageId!);
    } catch {
      before = "";
    }
  }

  const hash = contentHash(markdown);
  const payload: NotionPagePayload = {
    mode: input.mode,
    ...(input.pageId ? { pageId: input.pageId } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.parentType ? { parentType: input.parentType } : {}),
    title: input.title,
    markdown,
    contentHash: hash,
    ...(before ? { before } : {}),
  };

  const expectedEffect =
    input.mode === "append"
      ? `Append ${countBlocks(markdown)} to “${input.title}” in Notion`
      : `Create the Notion page “${input.title}”`;

  const result = await withTransaction(async (tx) => {
    const created = await createProposal(tx, { workspaceId: auth.workspaceId }, {
      capability: input.mode === "append" ? NOTION_PAGE_APPEND : NOTION_PAGE_CREATE,
      riskClass: "external_write",
      targetType: "notion_page",
      ...(input.pageId ? { targetId: input.pageId } : {}),
      title: expectedEffect,
      expectedEffect,
      dedupeKey: input.dedupeKey,
      runId: input.runId ?? null,
      // A stale Notion write is worse than none: the page has moved on.
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    if (!created.deduplicated) {
      // The account is pinned into the revision exactly as an email send pins
      // its sender, so approving binds the write to one connected Notion
      // workspace and a later reconnect cannot redirect it.
      const pin = await senderAccountPin(auth, input.mode === "append" ? NOTION_PAGE_APPEND : NOTION_PAGE_CREATE, input.accountAlias ?? null);
      await tx.insert(actionRevisions).values({
        workspaceId: auth.workspaceId,
        proposalId: created.proposalId,
        revisionNumber: 1,
        payload: { ...payload, ...(pin ? { accountPin: pin } : {}) },
        preview: {
          kind: "diff",
          // The hash is in the preview so the review card can show it and the
          // executor can prove the approved text is the written text.
          contentHash: hash,
          diff: input.mode === "append" ? appendPreview(before, markdown) : markdown,
          title: input.title,
          url: input.pageId ? `https://notion.so/${input.pageId.replace(/-/g, "")}` : null,
        },
      });
    }
    return created;
  });

  return { ...result, contentHash: hash };
}

/** Rough block count for the effect line; the real count is known at execution. */
function countBlocks(markdown: string): string {
  const lines = markdown.split("\n").filter((line) => line.trim()).length;
  return `${lines} line${lines === 1 ? "" : "s"}`;
}

export type NotionEffectOutcome = {
  status: "sent" | "failed";
  providerId?: string;
  url?: string;
  error?: string;
};

/**
 * Apply an approved Notion proposal. Called only by the executor after the
 * owner's approval; the revision's payload is the approved text and its hash is
 * re-checked here so a mismatched row can never be written.
 */
export async function applyNotionProposal(
  auth: AuthContext,
  input: { proposalId: string; accountAlias: string; client?: NotionWriteClient },
): Promise<NotionEffectOutcome> {
  const [row] = await db
    .select({ payload: actionRevisions.payload, revisionNumber: actionRevisions.revisionNumber })
    .from(actionRevisions)
    .innerJoin(actionProposals, eq(actionProposals.id, actionRevisions.proposalId))
    .where(and(eq(actionProposals.id, input.proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
    .orderBy(actionRevisions.revisionNumber)
    .limit(1);
  if (!row) return { status: "failed", error: "proposal has no revision to apply" };

  const payload = row.payload as NotionPagePayload;
  // The only integrity check available: the text that runs is the text the
  // owner approved. A hash mismatch means the row was edited after review.
  if (contentHash(payload.markdown) !== payload.contentHash) {
    return { status: "failed", error: "approved content changed; the proposal must be reviewed again" };
  }

  let client = input.client;
  if (!client) {
    try {
      client = composioNotionWriteClient(input.accountAlias);
    } catch {
      return { status: "failed", error: "Notion is not connected" };
    }
  }

  try {
    if (payload.mode === "append") {
      const result = await client.appendMarkdown(payload.pageId!, payload.markdown);
      return { status: "sent", providerId: result.pageId, url: `https://notion.so/${result.pageId.replace(/-/g, "")}` };
    }
    const result = await client.createPage({
      parentId: payload.parentId!,
      parentType: payload.parentType ?? "page",
      title: payload.title,
      markdown: payload.markdown,
    });
    return { status: "sent", providerId: result.pageId, url: result.url };
  } catch (cause) {
    // An append that may or may not have landed is "unknown" upstream; the
    // executor's attempt row carries that, so here it is a plain failure and
    // the reconciliation view decides whether to retry.
    return { status: "failed", error: cause instanceof Error ? cause.message : "Notion write failed" };
  }
}

/** The read client for a workspace's connected Notion account, when one exists. */
export async function notionReaderFor(connectedAccountId: string) {
  return composioNotionClient(connectedAccountId);
}
