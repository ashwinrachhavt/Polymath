import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionAttempts, actionProposals, actionRevisions, providerObservations } from "@/domains/actions/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import type { Transport, TransportRequest } from "@/domains/integrations/transport";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The reconciliation sweep's Canva branch, against real Postgres and a fake
 * transport. The properties this file exists to prove:
 *  1. an in-progress job settles nothing - it is an observed state, not
 *     absence, and no lag window turns it into a failure;
 *  2. a terminal success settles succeeded with the design id and an
 *     "imported" observation;
 *  3. a terminal failure settles failed with Canva's error code;
 *  4. an attempt WITHOUT a job id (a lost creation response) is left UNKNOWN
 *     and the sweep makes no provider call that could find or re-create it;
 *  5. a revoked account leaves the row for a human;
 *  6. the sweep only ever READS the job endpoint.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let reconciliation: typeof import("@/domains/actions/reconciliation");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  process.env.CANVA_IMPORT_ENABLED = "true";
  reconciliation = await import("@/domains/actions/reconciliation");
});
afterAll(async () => {
  delete process.env.CANVA_IMPORT_ENABLED;
  await handle?.client.end();
});

type Seeded = {
  workspaceId: string;
  proposalId: string;
  attemptId: string;
  connectedAccountId: string;
};

let counter = 0;

async function seedUnknown(options: {
  slug: string;
  /** responseSummary on the attempt: the job pointer, or null for a lost creation. */
  responseSummary: unknown;
  accountStatus?: "active" | "revoked";
  startedAt?: Date;
}): Promise<Seeded> {
  counter += 1;
  const { userId, workspaceId } = await seedWorkspace(db, `${options.slug}-${Date.now()}-${counter}`);
  const alias = `recon-canva-${counter}`;
  const connectedAccountId = `ca_${crypto.randomUUID()}`;
  await db.insert(externalAccounts).values({
    workspaceId,
    provider: "canva",
    alias,
    status: options.accountStatus ?? "active",
    composioConnectedAccountId: options.accountStatus === "revoked" ? null : connectedAccountId,
    createdBy: userId,
    updatedBy: userId,
  });
  const [proposal] = await db
    .insert(actionProposals)
    .values({
      workspaceId,
      capability: "canva.design.import",
      riskClass: "external_write",
      status: "approved",
      accountAlias: alias,
      title: "Import design brief to Canva",
      expectedEffect: "Creates one new Canva design.",
      dedupeKey: `recon-canva:${workspaceId}:${counter}`,
      decidedAt: new Date(),
      decidedBy: userId,
    })
    .returning();
  const [revision] = await db
    .insert(actionRevisions)
    .values({ workspaceId, proposalId: proposal.id, revisionNumber: 1, payload: {}, createdBy: userId })
    .returning();
  const [attempt] = await db
    .insert(actionAttempts)
    .values({
      workspaceId,
      proposalId: proposal.id,
      revisionId: revision.id,
      attemptNumber: 1,
      idempotencyKey: `exec:${proposal.id}`,
      status: "unknown",
      reconciliation: "pending",
      responseSummary: options.responseSummary as Record<string, unknown> | null,
      providerObjectId: (options.responseSummary as { jobId?: string } | null)?.jobId ?? null,
      startedAt: options.startedAt ?? new Date(),
    })
    .returning();
  return { workspaceId, proposalId: proposal.id, attemptId: attempt.id, connectedAccountId };
}

/** A transport that answers get-job reads per job id and records every request. */
function transportWith(jobs: Record<string, unknown>): Transport & { calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  return {
    calls,
    async read(request) {
      calls.push(request);
      const jobId = request.endpoint.split("/").pop() ?? "";
      if (jobId in jobs) return { ok: true, status: 200, data: { job: { id: jobId, ...(jobs[jobId] as object) } } };
      return { ok: false, code: "provider_error", status: 404, message: "The connected service returned 404." };
    },
  };
}

async function attemptState(attemptId: string) {
  const [attempt] = await db.select().from(actionAttempts).where(eq(actionAttempts.id, attemptId));
  const observations = await db.select().from(providerObservations).where(eq(providerObservations.attemptId, attemptId));
  return { attempt, observations };
}

suite("canva.design.import reconciliation", () => {
  it("an in-progress job settles nothing and is re-asked after the poll interval", async () => {
    const seeded = await seedUnknown({ slug: "canva-recon-progress", responseSummary: { jobId: "job_p", phase: "import_in_progress" } });
    const transport = transportWith({ job_p: { status: "in_progress" } });

    const result = await reconciliation.reconcileUnknownAttempts({ transport });
    expect(result.reconciled).toBe(0);
    const { attempt, observations } = await attemptState(seeded.attemptId);
    expect(attempt.status).toBe("unknown");
    expect(attempt.reconciliation).toBe("pending");
    expect(observations).toHaveLength(0);
    expect(transport.calls).toHaveLength(1);
  });

  it("the poll interval gates re-asks: an immediate second pass reads nothing, a later pass re-asks", async () => {
    const seeded = await seedUnknown({ slug: "canva-recon-interval", responseSummary: { jobId: "job_i", phase: "import_in_progress" } });
    const transport = transportWith({ job_i: { status: "in_progress" } });

    await reconciliation.reconcileUnknownAttempts({ transport });
    expect(transport.calls).toHaveLength(1);

    // Inside the interval the claimed slot stands: no second provider read.
    await reconciliation.reconcileUnknownAttempts({ transport });
    expect(transport.calls).toHaveLength(1);

    // Once the interval has passed (polledAt backdated), the next pass re-asks.
    await db
      .update(actionAttempts)
      .set({
        responseSummary: {
          jobId: "job_i",
          phase: "import_in_progress",
          polledAt: Date.now() - (reconciliation.CANVA_IMPORT_MIN_POLL_INTERVAL_MS + 60_000),
        },
      })
      .where(eq(actionAttempts.id, seeded.attemptId));
    await reconciliation.reconcileUnknownAttempts({ transport });
    expect(transport.calls).toHaveLength(2);

    const { attempt } = await attemptState(seeded.attemptId);
    expect(attempt.status).toBe("unknown");
    expect(attempt.reconciliation).toBe("pending");
  });

  it("concurrent sweeps cannot multiply reads or double-settle: one read, one observation, one audit line", async () => {
    const seeded = await seedUnknown({ slug: "canva-recon-race", responseSummary: { jobId: "job_race", phase: "import_in_progress" } });
    const transport = transportWith({
      job_race: { status: "success", result: { designs: [{ id: "RACE1", urls: { edit_url: "https://www.canva.com/design/RACE1/edit" } }] } },
    });

    // Two ticks fire at once: the atomic poll-slot claim admits exactly one
    // reader, and the settle fence admits exactly one writer.
    const [a, b] = await Promise.all([
      reconciliation.reconcileUnknownAttempts({ transport }),
      reconciliation.reconcileUnknownAttempts({ transport }),
    ]);
    expect(a.reconciled + b.reconciled).toBe(1);
    expect(transport.calls).toHaveLength(1);

    const { attempt, observations } = await attemptState(seeded.attemptId);
    expect(attempt.status).toBe("succeeded");
    expect(attempt.reconciliation).toBe("resolved");
    expect(observations).toHaveLength(1);
  });

  it("a terminal success settles succeeded with the design id and an imported observation", async () => {
    const seeded = await seedUnknown({ slug: "canva-recon-success", responseSummary: { jobId: "job_s", phase: "import_in_progress" } });
    const transport = transportWith({
      job_s: { status: "success", result: { designs: [{ id: "DAF9", urls: { edit_url: "https://www.canva.com/design/DAF9/edit" } }] } },
    });

    const result = await reconciliation.reconcileUnknownAttempts({ transport });
    expect(result.reconciled).toBe(1);
    const { attempt, observations } = await attemptState(seeded.attemptId);
    expect(attempt.status).toBe("succeeded");
    expect(attempt.reconciliation).toBe("resolved");
    expect(attempt.providerObjectId).toBe("DAF9");
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ provider: "canva", observedState: "imported", providerObjectId: "DAF9" });
    expect(transport.calls[0]).toMatchObject({
      connectedAccountId: seeded.connectedAccountId,
      endpoint: "https://api.canva.com/rest/v1/imports/job_s",
      method: "GET",
    });
  });

  it("a terminal failure settles failed with Canva's error code", async () => {
    const seeded = await seedUnknown({ slug: "canva-recon-failed", responseSummary: { jobId: "job_f", phase: "import_in_progress" } });
    const transport = transportWith({ job_f: { status: "failed", error: { code: "invalid_file", message: "nope" } } });

    const result = await reconciliation.reconcileUnknownAttempts({ transport });
    expect(result.reconciled).toBe(1);
    const { attempt, observations } = await attemptState(seeded.attemptId);
    expect(attempt.status).toBe("failed");
    expect(attempt.errorCode).toBe("canva_import_failed");
    expect(observations[0]).toMatchObject({ provider: "canva", observedState: "import_failed" });
  });

  it("a lost creation (no job id) is left UNKNOWN and the sweep makes no provider call for it", async () => {
    const seeded = await seedUnknown({ slug: "canva-recon-lost", responseSummary: { message: "The provider did not answer." } });
    const transport = transportWith({});

    const result = await reconciliation.reconcileUnknownAttempts({ transport });
    expect(result.reconciled).toBe(0);
    const { attempt } = await attemptState(seeded.attemptId);
    expect(attempt.status).toBe("unknown");
    expect(attempt.reconciliation).toBe("pending");
    // No list-imports endpoint exists, so no read was even attempted: there is
    // no honest question to ask, and asking none is what no-refire means.
    expect(transport.calls).toHaveLength(0);
  });

  it("a revoked account leaves the row for a human", async () => {
    const seeded = await seedUnknown({
      slug: "canva-recon-revoked",
      responseSummary: { jobId: "job_r", phase: "import_in_progress" },
      accountStatus: "revoked",
    });
    const transport = transportWith({ job_r: { status: "success", result: { designs: [{ id: "DAF1" }] } } });

    const result = await reconciliation.reconcileUnknownAttempts({ transport });
    expect(result.reconciled).toBe(0);
    const { attempt } = await attemptState(seeded.attemptId);
    expect(attempt.status).toBe("unknown");
    expect(transport.calls).toHaveLength(0);
  });

  it("polling is bounded: a job older than the budget is left for a human with no provider call", async () => {
    const seeded = await seedUnknown({
      slug: "canva-recon-bounded",
      responseSummary: { jobId: "job_old", phase: "import_in_progress" },
      startedAt: new Date(Date.now() - 25 * 60 * 60_000),
    });
    const transport = transportWith({ job_old: { status: "success", result: { designs: [{ id: "DAF2" }] } } });

    const result = await reconciliation.reconcileUnknownAttempts({ transport });
    expect(result.reconciled).toBe(0);
    const { attempt } = await attemptState(seeded.attemptId);
    expect(attempt.status).toBe("unknown");
    expect(attempt.reconciliation).toBe("pending");
    expect(transport.calls).toHaveLength(0);
  });

  it("a disabled live import leaves the row UNKNOWN at zero provider calls", async () => {
    // The enablement boundary covers polling too: even with a job id on the
    // row and a transport that would answer success, the sweep asks nothing.
    const seeded = await seedUnknown({ slug: "canva-recon-disabled", responseSummary: { jobId: "job_d", phase: "import_in_progress" } });
    const transport = transportWith({ job_d: { status: "success" } });
    delete process.env.CANVA_IMPORT_ENABLED;
    let result;
    try {
      result = await reconciliation.reconcileUnknownAttempts({ transport });
    } finally {
      process.env.CANVA_IMPORT_ENABLED = "true";
    }
    expect(result!.reconciled).toBe(0);
    expect(transport.calls).toHaveLength(0);
    const { attempt } = await attemptState(seeded.attemptId);
    expect(attempt.status).toBe("unknown");
    expect(attempt.reconciliation).toBe("pending");
  });

  it("a transport error settles nothing", async () => {
    const seeded = await seedUnknown({ slug: "canva-recon-transport-err", responseSummary: { jobId: "job_x", phase: "import_in_progress" } });
    const transport: Transport = {
      async read() {
        return { ok: false, code: "provider_error", status: 503, message: "The connected service returned 503." };
      },
    };

    const result = await reconciliation.reconcileUnknownAttempts({ transport });
    expect(result.reconciled).toBe(0);
    const { attempt } = await attemptState(seeded.attemptId);
    expect(attempt.status).toBe("unknown");
    expect(attempt.reconciliation).toBe("pending");
  });
});
