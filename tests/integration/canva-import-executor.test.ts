import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { actionAttempts, actionPolicies, actionProposals, actionReviews, actionRevisions } from "@/domains/actions/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { designBriefDocx, designBriefDocxSha256 } from "@/domains/knowledge/design-brief-docx";
import type { DesignBrief } from "@/domains/knowledge/design-brief";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The canva.design.import executor, against real Postgres and a stubbed
 * fetch. The properties this file exists to prove:
 *  1. one approval creates exactly one import job; a created job settles the
 *     attempt UNKNOWN with the job id (a created job is not an imported
 *     design), and a replay returns that outcome without a second dispatch;
 *  2. a refused creation (proxy/provider 4xx) settles failed, terminal;
 *  3. a timeout settles UNKNOWN with no job id - the no-refire state the
 *     sweep must leave alone;
 *  4. a tampered docxSha256 refuses before any claim or provider call;
 *  5. account drift and an unpinned revision refuse before the provider.
 *
 * fetch is stubbed at the Composio seam so the real envelope, classification
 * and DOCX render are on the path.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let executor: typeof import("@/domains/actions/executor");

const API_KEY = "test-composio-key";
beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  process.env.COMPOSIO_API_KEY = API_KEY;
  executor = await import("@/domains/actions/executor");
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  delete process.env.COMPOSIO_API_KEY;
  await handle?.client.end();
});

const brief: DesignBrief = {
  title: "Launch one-pager",
  objective: "Align the team on the launch story.",
  audience: "Founders",
  keyMessage: "The research card becomes the pitch.",
  tone: ["direct"],
  format: "doc",
  visualDirection: "Sparse and typographic.",
  deliverables: ["One-pager"],
  constraints: null,
  callToAction: null,
};

function stubProvider(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const spy = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  });
  vi.stubGlobal("fetch", spy);
  return { spy, calls };
}

const jobCreated = (jobId = "job_1") => () =>
  new Response(JSON.stringify({ data: { job: { id: jobId, status: "in_progress" } } }), { status: 200 });

let counter = 0;

async function seedImport(options: {
  slug: string;
  /** Overrides for the approved payload (integrity/drift pins). */
  payload?: Record<string, unknown>;
  unpinned?: boolean;
  driftAccount?: boolean;
  accountStatus?: "active" | "revoked";
}): Promise<{ auth: ReturnType<typeof ownerAuth>; proposalId: string; workspaceId: string }> {
  counter += 1;
  const { userId, workspaceId } = await seedWorkspace(db, `${options.slug}-${Date.now()}-${counter}`);
  const auth = ownerAuth(userId, workspaceId);
  const alias = `canva-main-${counter}`;
  const [account] = await db
    .insert(externalAccounts)
    .values({
      workspaceId,
      provider: "canva",
      alias,
      status: options.accountStatus ?? "active",
      composioConnectedAccountId: options.accountStatus === "revoked" ? null : `ca_${crypto.randomUUID()}`,
      createdBy: userId,
      updatedBy: userId,
    })
    .returning();

  const [proposal] = await db
    .insert(actionProposals)
    .values({
      workspaceId,
      capability: "canva.design.import",
      riskClass: "external_write",
      status: "approved",
      accountAlias: alias,
      title: `Import design brief "${brief.title}" to Canva`,
      expectedEffect: "Creates one new Canva design.",
      dedupeKey: `canva.design.import:${workspaceId}:artifact-${counter}:version-1`,
      decidedAt: new Date(),
      decidedBy: userId,
    })
    .returning();

  const pin = options.unpinned
    ? {}
    : {
        accountPin: {
          resolved: true,
          externalAccountId: account.id,
          // Drift: the approval pinned a different connected-account id than
          // the live resolution now returns.
          connectedAccountId: options.driftAccount ? `ca_other_${counter}` : account.composioConnectedAccountId,
          alias,
          sender: alias,
        },
      };
  const [revision] = await db
    .insert(actionRevisions)
    .values({
      workspaceId,
      proposalId: proposal.id,
      revisionNumber: 1,
      payload: {
        title: `Design brief: ${brief.title}`,
        brief,
        docxSha256: designBriefDocxSha256(brief),
        ...pin,
        ...(options.payload ?? {}),
      },
      preview: { title: brief.title, ...pin },
      createdBy: userId,
    })
    .returning();
  await db.insert(actionReviews).values({
    workspaceId,
    proposalId: proposal.id,
    revisionId: revision.id,
    decision: "approved",
    reviewedBy: userId,
  });
  return { auth, proposalId: proposal.id, workspaceId };
}

suite("canva.design.import executor", () => {
  it("creates exactly one job; the attempt stays UNKNOWN with the job id and a replay does not re-dispatch", async () => {
    const seeded = await seedImport({ slug: "canva-once" });
    const { spy, calls } = stubProvider(jobCreated("job_42"));

    const first = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(first).toMatchObject({ status: "unknown" });

    // The envelope carried the real DOCX render of the approved brief.
    const envelope = JSON.parse(String(calls[0]!.init.body));
    expect(envelope.binary_body.base64).toBe(Buffer.from(designBriefDocx(brief)).toString("base64"));

    const second = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(second).toMatchObject({ status: "unknown" });
    expect(spy).toHaveBeenCalledTimes(1);

    const attempts = await db.select().from(actionAttempts).where(eq(actionAttempts.proposalId, seeded.proposalId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("unknown");
    expect(attempts[0]!.reconciliation).toBe("pending");
    expect(attempts[0]!.providerObjectId).toBe("job_42");
    expect(attempts[0]!.errorCode).toBe("import_in_progress");
    expect(attempts[0]!.responseSummary).toMatchObject({ jobId: "job_42", phase: "import_in_progress" });
  });

  it("a proxy 4xx refusal settles failed and terminal; a replay does not re-dispatch", async () => {
    const seeded = await seedImport({ slug: "canva-rejected" });
    const { spy } = stubProvider(() => new Response("rate limited", { status: 429 }));

    const first = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(first).toMatchObject({ status: "failed", retryable: false });
    const second = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(second).toMatchObject({ status: "failed" });
    expect(spy).toHaveBeenCalledTimes(1);

    const [attempt] = await db.select().from(actionAttempts).where(eq(actionAttempts.proposalId, seeded.proposalId));
    expect(attempt.status).toBe("failed");
    expect(attempt.errorCode).toBe("provider_rejected_429");
  });

  it("a timeout settles UNKNOWN with no job id - the state that must never re-fire", async () => {
    const seeded = await seedImport({ slug: "canva-timeout" });
    stubProvider(() => Promise.reject(new Error("The operation timed out.")));

    const outcome = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(outcome).toMatchObject({ status: "unknown" });

    const [attempt] = await db.select().from(actionAttempts).where(eq(actionAttempts.proposalId, seeded.proposalId));
    expect(attempt.status).toBe("unknown");
    expect(attempt.errorCode).toBe("import_outcome_unknown");
    expect(attempt.providerObjectId).toBeNull();
    expect((attempt.responseSummary as { jobId?: unknown } | null)?.jobId).toBeUndefined();
  });

  it("refuses a payload whose pinned DOCX hash no longer matches the render, before any claim or provider call", async () => {
    const seeded = await seedImport({ slug: "canva-integrity", payload: { docxSha256: "0".repeat(64) } });
    const { spy } = stubProvider(jobCreated());

    await expect(executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId })).rejects.toThrow(
      /no longer renders to the approved document/,
    );
    expect(spy).not.toHaveBeenCalled();
    const attempts = await db.select().from(actionAttempts).where(eq(actionAttempts.proposalId, seeded.proposalId));
    expect(attempts).toHaveLength(0);
  });

  it("refuses when the connected account drifted from the approved pin", async () => {
    const seeded = await seedImport({ slug: "canva-drift", driftAccount: true });
    const { spy } = stubProvider(jobCreated());

    await expect(executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId })).rejects.toThrow(
      /no longer matches the approved revision/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("a replay of a job-created attempt reports the import_started phase, not a fresh dispatch", async () => {
    const seeded = await seedImport({ slug: "canva-phase-note" });
    const { spy } = stubProvider(jobCreated("job_77"));

    await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    const replay = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(replay).toMatchObject({ status: "unknown", note: "import_started" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("an unconfigured deployment refuses BEFORE any claim or provider call", async () => {
    const seeded = await seedImport({ slug: "canva-unconfigured" });
    const { spy } = stubProvider(jobCreated());
    delete process.env.COMPOSIO_API_KEY;
    try {
      await expect(executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId })).rejects.toThrow(
        /Composio is not configured/,
      );
    } finally {
      process.env.COMPOSIO_API_KEY = API_KEY;
    }
    expect(spy).not.toHaveBeenCalled();
    // No UNKNOWN attempt blocks the proposal against a configuration fix.
    const attempts = await db.select().from(actionAttempts).where(eq(actionAttempts.proposalId, seeded.proposalId));
    expect(attempts).toHaveLength(0);
  });

  it("a revoked account is refused before the provider is touched", async () => {
    const seeded = await seedImport({ slug: "canva-revoked", accountStatus: "revoked" });
    const { spy } = stubProvider(jobCreated());

    await expect(executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    const attempts = await db.select().from(actionAttempts).where(eq(actionAttempts.proposalId, seeded.proposalId));
    expect(attempts).toHaveLength(0);
  });

  it("tightening the sender grant after approval revokes the approved import", async () => {
    const seeded = await seedImport({ slug: "canva-grant-tightened" });
    const { spy } = stubProvider(jobCreated());
    // The workspace's grant now names a DIFFERENT alias: the approved pin's
    // alias is no longer authorized, so the approval must not grandfather.
    await db.insert(actionPolicies).values({
      workspaceId: seeded.workspaceId,
      capability: "canva.design.import",
      riskClass: "external_write",
      constraints: { allowedSenderAliases: ["someone-else"] },
      createdBy: seeded.auth.userId,
      updatedBy: seeded.auth.userId,
    });

    await expect(executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId })).rejects.toThrow(
      /not an authorized sender/,
    );
    expect(spy).not.toHaveBeenCalled();
    const attempts = await db.select().from(actionAttempts).where(eq(actionAttempts.proposalId, seeded.proposalId));
    expect(attempts).toHaveLength(0);
  });

  it("no grant row means unrestricted (absent is not block-all)", async () => {
    // Absent-key semantics, pinned: a workspace that never saved a grant for
    // this capability keeps the unrestricted behavior.
    const seeded = await seedImport({ slug: "canva-grant-absent" });
    const { spy } = stubProvider(jobCreated("job_abs"));
    const outcome = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(outcome).toMatchObject({ status: "unknown", note: "import_started" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("an empty grant list is a deliberate block-all", async () => {
    const seeded = await seedImport({ slug: "canva-grant-empty" });
    const { spy } = stubProvider(jobCreated());
    await db.insert(actionPolicies).values({
      workspaceId: seeded.workspaceId,
      capability: "canva.design.import",
      riskClass: "external_write",
      constraints: { allowedSenderAliases: [] },
      createdBy: seeded.auth.userId,
      updatedBy: seeded.auth.userId,
    });
    await expect(executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId })).rejects.toThrow(
      /No sender is authorized/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("a grant scoped to canva.design.import never touches gmail.send authority", async () => {
    // Scope mapping, pinned: the policy row is keyed by CAPABILITY, not by
    // provider or account. A canva block-all leaves gmail.send unrestricted
    // in the same workspace, and the canva alias vocabulary is never read
    // as a gmail sender permission.
    const seeded = await seedImport({ slug: "canva-grant-scoped" });
    await db.insert(actionPolicies).values({
      workspaceId: seeded.workspaceId,
      capability: "canva.design.import",
      riskClass: "external_write",
      constraints: { allowedSenderAliases: [] },
      createdBy: seeded.auth.userId,
      updatedBy: seeded.auth.userId,
    });
    const { senderAliasPolicy } = await import("@/domains/actions/policy");
    expect(await senderAliasPolicy(seeded.workspaceId, "gmail.send")).toEqual({ configured: false });
    expect(await senderAliasPolicy(seeded.workspaceId, "canva.design.import")).toEqual({ configured: true, aliases: [] });

    const { spy } = stubProvider(jobCreated());
    await expect(executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId })).rejects.toThrow(
      /No sender is authorized/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a revision written before account binding", async () => {
    const seeded = await seedImport({ slug: "canva-unpinned", unpinned: true });
    const { spy } = stubProvider(jobCreated());

    await expect(executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId })).rejects.toThrow(
      /before a sending account was bound/,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
