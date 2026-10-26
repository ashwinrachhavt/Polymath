import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { actionAttempts, actionPolicies, actionProposals, actionReviews, actionRevisions } from "@/domains/actions/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-283: the Notion proposal path with fake read and write clients. Nothing
 * here reaches Notion. What must hold: the stored revision carries the exact
 * text and its hash, an edited note proposes again rather than resolving to the
 * old text, a failed page read does not block the proposal, an apply refuses
 * text that no longer matches its hash, and a workspace cannot apply another
 * workspace's proposal.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let notion: typeof import("@/domains/knowledge/notion-proposals");
let executor: typeof import("@/domains/actions/executor");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  process.env.COMPOSIO_API_KEY = "test-composio-key";
  notion = await import("@/domains/knowledge/notion-proposals");
  executor = await import("@/domains/actions/executor");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  delete process.env.COMPOSIO_API_KEY;
  await handle?.client.end();
});

const PAGE = "0123456789abcdef0123456789abcdef";

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${crypto.randomUUID().slice(0, 8)}`);
  return { auth: ownerAuth(userId, workspaceId), workspaceId };
}

async function revisionOf(proposalId: string) {
  const [row] = await db.select().from(actionRevisions).where(eq(actionRevisions.proposalId, proposalId));
  return row;
}

function writeClient() {
  const calls: { kind: string; args: unknown[] }[] = [];
  return {
    calls,
    client: {
      async appendMarkdown(pageId: string, markdown: string) {
        calls.push({ kind: "append", args: [pageId, markdown] });
        return { pageId, blocksAdded: 1 };
      },
      async createPage(input: { parentId: string; parentType: "page" | "database"; title: string; markdown: string }) {
        calls.push({ kind: "create", args: [input] });
        return { pageId: "fedcba9876543210fedcba9876543210", url: "https://notion.so/new", blocksAdded: 1 };
      },
    },
  };
}

suite("notion page proposals", () => {
  it("stores the exact text, its hash and a diff with the page's last lines as context", async () => {
    const { auth, workspaceId } = await seed("notion-before");
    const markdown = "## Decision\n- ship Friday";
    const result = await notion.proposeNotionPageUpdate(auth, {
      mode: "append",
      pageId: PAGE,
      title: "Launch log",
      markdown,
      dedupeKey: `n-${crypto.randomUUID()}`,
      readClient: { getPageMarkdown: async () => "line one\nline two\nline three\nline four" },
    });

    const revision = await revisionOf(result.proposalId);
    const payload = revision.payload as { markdown: string; contentHash: string; mode: string };
    expect(payload.markdown).toBe(markdown);
    expect(payload.contentHash).toBe(notion.contentHash(markdown));
    expect(result.contentHash).toBe(payload.contentHash);
    const preview = revision.preview as { kind: string; contentHash: string; diff: string };
    expect(preview.kind).toBe("diff");
    expect(preview.contentHash).toBe(payload.contentHash);
    expect(preview.diff).toContain(" line four");
    expect(preview.diff).not.toContain("line one");
    expect(preview.diff).toContain("+- ship Friday");

    const [proposal] = await db.select().from(actionProposals).where(eq(actionProposals.id, result.proposalId));
    expect(proposal.workspaceId).toBe(workspaceId);
    expect(proposal.capability).toBe("notion.page.append");
    expect(proposal.riskClass).toBe("external_write");
    expect(proposal.expiresAt).not.toBeNull();
  });

  it("still proposes, without context, when the page cannot be read", async () => {
    const { auth } = await seed("notion-unreadable");
    const result = await notion.proposeNotionPageUpdate(auth, {
      mode: "append",
      pageId: PAGE,
      title: "Launch log",
      markdown: "new",
      dedupeKey: `n-${crypto.randomUUID()}`,
      readClient: {
        getPageMarkdown: async () => {
          throw new Error("notion is down");
        },
      },
    });
    const revision = await revisionOf(result.proposalId);
    expect((revision.preview as { diff: string }).diff).toBe("+new");
    expect(revision.payload).not.toHaveProperty("before");
  });

  it("resolves a retry with the same key to the same proposal and one revision", async () => {
    const { auth } = await seed("notion-dedupe");
    const input = { mode: "append" as const, pageId: PAGE, title: "Log", markdown: "same", dedupeKey: `n-${crypto.randomUUID()}` };
    const first = await notion.proposeNotionPageUpdate(auth, input);
    const second = await notion.proposeNotionPageUpdate(auth, input);
    expect(second.deduplicated).toBe(true);
    expect(second.proposalId).toBe(first.proposalId);
    const revisions = await db.select().from(actionRevisions).where(eq(actionRevisions.proposalId, first.proposalId));
    expect(revisions).toHaveLength(1);
  });

  it("keys the editor action on content, so an edited note proposes the new text", async () => {
    // The same function the editor's server action calls: two texts must give
    // two keys and one text must give one.
    const keyFor = (markdown: string) => notion.noteNotionDedupeKey("note-1", PAGE, markdown);
    expect(keyFor("v1")).toBe(keyFor("v1"));
    expect(keyFor("v1")).not.toBe(keyFor("v2"));

    const { auth } = await seed("notion-edited");
    const one = await notion.proposeNotionPageUpdate(auth, { mode: "append", pageId: PAGE, title: "Log", markdown: "v1", dedupeKey: keyFor("v1") });
    const two = await notion.proposeNotionPageUpdate(auth, { mode: "append", pageId: PAGE, title: "Log", markdown: "v2", dedupeKey: keyFor("v2") });
    expect(two.proposalId).not.toBe(one.proposalId);
    expect(two.contentHash).not.toBe(one.contentHash);
  });

  it("refuses empty content and a missing target before writing anything", async () => {
    const { auth, workspaceId } = await seed("notion-invalid");
    const base = { title: "T", dedupeKey: `n-${crypto.randomUUID()}` };
    await expect(notion.proposeNotionPageUpdate(auth, { ...base, mode: "append", pageId: PAGE, markdown: "   " })).rejects.toMatchObject({ code: "empty_content" });
    await expect(notion.proposeNotionPageUpdate(auth, { ...base, mode: "append", markdown: "x" })).rejects.toMatchObject({ code: "page_not_found" });
    await expect(notion.proposeNotionPageUpdate(auth, { ...base, mode: "create", markdown: "x" })).rejects.toMatchObject({ code: "page_not_found" });
    const rows = await db.select().from(actionProposals).where(eq(actionProposals.workspaceId, workspaceId));
    expect(rows).toHaveLength(0);
  });

  it("pins an unresolved account into the revision when no Notion account is connected", async () => {
    const { auth } = await seed("notion-pin");
    const result = await notion.proposeNotionPageUpdate(auth, { mode: "append", pageId: PAGE, title: "Log", markdown: "x", dedupeKey: `n-${crypto.randomUUID()}` });
    const payload = (await revisionOf(result.proposalId)).payload as { accountPin?: { resolved: boolean; provider: string } };
    expect(payload.accountPin).toMatchObject({ resolved: false, provider: "notion" });
  });

  it("applies the approved text, and a create returns the new page", async () => {
    const { auth } = await seed("notion-apply");
    const appended = await notion.proposeNotionPageUpdate(auth, { mode: "append", pageId: PAGE, title: "Log", markdown: "approved text", dedupeKey: `n-${crypto.randomUUID()}` });
    const created = await notion.proposeNotionPageUpdate(auth, { mode: "create", parentId: PAGE, parentType: "database", title: "New", markdown: "# body", dedupeKey: `n-${crypto.randomUUID()}` });
    const fake = writeClient();

    const a = await notion.applyNotionProposal(auth, { proposalId: appended.proposalId, accountAlias: "any", client: fake.client });
    expect(a).toMatchObject({ status: "sent", providerId: PAGE });
    const c = await notion.applyNotionProposal(auth, { proposalId: created.proposalId, accountAlias: "any", client: fake.client });
    expect(c).toMatchObject({ status: "sent", url: "https://notion.so/new" });
    expect(fake.calls).toEqual([
      { kind: "append", args: [PAGE, "approved text"] },
      { kind: "create", args: [{ parentId: PAGE, parentType: "database", title: "New", markdown: "# body" }] },
    ]);
  });

  it("refuses to write text that no longer matches the approved hash", async () => {
    const { auth } = await seed("notion-tamper");
    const result = await notion.proposeNotionPageUpdate(auth, { mode: "append", pageId: PAGE, title: "Log", markdown: "reviewed", dedupeKey: `n-${crypto.randomUUID()}` });
    const revision = await revisionOf(result.proposalId);
    await db
      .update(actionRevisions)
      .set({ payload: { ...(revision.payload as object), markdown: "changed after review" } })
      .where(eq(actionRevisions.id, revision.id));

    const fake = writeClient();
    const outcome = await notion.applyNotionProposal(auth, { proposalId: result.proposalId, accountAlias: "any", client: fake.client });
    expect(outcome.status).toBe("failed");
    expect(fake.calls).toHaveLength(0);
  });

  it("does not apply another workspace's proposal", async () => {
    const owner = await seed("notion-owner");
    const other = await seed("notion-other");
    const result = await notion.proposeNotionPageUpdate(owner.auth, { mode: "append", pageId: PAGE, title: "Log", markdown: "private", dedupeKey: `n-${crypto.randomUUID()}` });
    const fake = writeClient();
    const outcome = await notion.applyNotionProposal(other.auth, { proposalId: result.proposalId, accountAlias: "any", client: fake.client });
    expect(outcome.status).toBe("failed");
    expect(fake.calls).toHaveLength(0);
  });
});

/*
 * The executor's gate before any Notion call. Each case fails before dispatch,
 * so the fetch spy proves nothing reached the provider and the empty attempts
 * table proves no attempt was claimed.
 */
suite("notion execution gate", () => {
  let counter = 0;

  async function seedApproved(options: { connected?: boolean } = {}) {
    counter += 1;
    const { userId, workspaceId } = await seedWorkspace(db, `notion-exec-${crypto.randomUUID().slice(0, 8)}-${counter}`);
    const auth = ownerAuth(userId, workspaceId);
    const alias = `notion-${counter}`;
    let account: typeof externalAccounts.$inferSelect | null = null;
    if (options.connected !== false) {
      [account] = await db
        .insert(externalAccounts)
        .values({ workspaceId, provider: "notion", alias, status: "active", composioConnectedAccountId: `ca_${crypto.randomUUID()}`, createdBy: userId, updatedBy: userId })
        .returning();
    }
    const proposed = await notion.proposeNotionPageUpdate(auth, {
      mode: "append",
      pageId: PAGE,
      title: "Log",
      markdown: "approved text",
      dedupeKey: `n-${crypto.randomUUID()}`,
    });
    const revision = await revisionOf(proposed.proposalId);
    await db.update(actionProposals).set({ status: "approved", decidedAt: new Date(), decidedBy: userId }).where(eq(actionProposals.id, proposed.proposalId));
    await db.insert(actionReviews).values({ workspaceId, proposalId: proposed.proposalId, revisionId: revision.id, decision: "approved", reviewedBy: userId });
    return { auth, workspaceId, userId, account, alias, proposalId: proposed.proposalId, revision };
  }

  function spyOnProvider() {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  async function expectRefusedBeforeDispatch(seeded: { auth: ReturnType<typeof ownerAuth>; proposalId: string }, spy: ReturnType<typeof spyOnProvider>) {
    await expect(executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId })).rejects.toBeInstanceOf(executor.SendNotAllowedError);
    expect(spy).not.toHaveBeenCalled();
    expect(await db.select().from(actionAttempts).where(eq(actionAttempts.proposalId, seeded.proposalId))).toHaveLength(0);
  }

  it("refuses an approval written before a Notion account was bound to it", async () => {
    const seeded = await seedApproved({ connected: false });
    // Connecting afterwards must not retroactively bind the approved revision.
    await db.insert(externalAccounts).values({ workspaceId: seeded.workspaceId, provider: "notion", alias: "late", status: "active", composioConnectedAccountId: `ca_${crypto.randomUUID()}`, createdBy: seeded.userId, updatedBy: seeded.userId });
    await expectRefusedBeforeDispatch(seeded, spyOnProvider());
  });

  it("refuses when the bound account is revoked", async () => {
    const seeded = await seedApproved();
    await db.update(externalAccounts).set({ status: "revoked", composioConnectedAccountId: null }).where(eq(externalAccounts.id, seeded.account!.id));
    await expectRefusedBeforeDispatch(seeded, spyOnProvider());
  });

  it("refuses when the account was reconnected under a new connection id", async () => {
    const seeded = await seedApproved();
    await db.update(externalAccounts).set({ composioConnectedAccountId: `ca_${crypto.randomUUID()}` }).where(eq(externalAccounts.id, seeded.account!.id));
    await expectRefusedBeforeDispatch(seeded, spyOnProvider());
  });

  it("refuses when the workspace later tightens the authorized aliases", async () => {
    const seeded = await seedApproved();
    await db.insert(actionPolicies).values({
      workspaceId: seeded.workspaceId,
      capability: "notion.page.append",
      riskClass: "external_write",
      constraints: { allowedSenderAliases: ["some-other-alias"] },
    });
    await expectRefusedBeforeDispatch(seeded, spyOnProvider());
  });

  it("refuses a proposal that was never approved", async () => {
    const seeded = await seedApproved();
    await db.update(actionProposals).set({ status: "pending" }).where(eq(actionProposals.id, seeded.proposalId));
    const spy = spyOnProvider();
    await expect(executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("settles a payload edited after approval as failed without calling Notion", async () => {
    const seeded = await seedApproved();
    await db
      .update(actionRevisions)
      .set({ payload: { ...(seeded.revision.payload as object), markdown: "changed after review" } })
      .where(eq(actionRevisions.id, seeded.revision.id));
    const spy = spyOnProvider();
    const outcome = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(outcome.status).toBe("failed");
    expect(spy).not.toHaveBeenCalled();
  });
});
