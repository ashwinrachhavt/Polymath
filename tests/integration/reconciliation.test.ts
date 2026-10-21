import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actionAttempts,
  actionProposals,
  actionRevisions,
  providerObservations,
} from "@/domains/actions/schema";
import { auditEvents } from "@/domains/audit/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Reconciliation closes UNKNOWN attempts, and its whole safety story is what it
 * refuses to conclude:
 *
 *  1. a marker the provider shows settles `succeeded` with the provider id;
 *  2. absence *older* than the index lag settles `failed`;
 *  3. absence inside the lag settles nothing - "not found yet" is not "not sent";
 *  4. a transport error settles nothing - the provider never answered;
 *  5. a `succeeded` attempt is never even selected;
 *  6. every settle writes its observation and audit row in the same transaction.
 *
 * The transport is a fake at the real seam, so the sweep's own parsing and the
 * Gmail search shape are on the path. Real Postgres, because the status,
 * reconciliation, observation and audit rows are the thing being proven.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let reconciliation: typeof import("@/domains/actions/reconciliation");
let reads: typeof import("@/domains/integrations/gmail/reads");
let send: typeof import("@/domains/integrations/gmail/send");
let transportModule: typeof import("@/domains/integrations/transport");

type ReadRequest = import("@/domains/integrations/transport").TransportRequest;
type ReadResult = import("@/domains/integrations/transport").TransportResult;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  reconciliation = await import("@/domains/actions/reconciliation");
  reads = await import("@/domains/integrations/gmail/reads");
  send = await import("@/domains/integrations/gmail/send");
  transportModule = await import("@/domains/integrations/transport");
  void reads;
  void send;
  void transportModule;
});

afterAll(async () => {
  await handle?.client.end();
});

type FakeTransport = {
  calls: ReadRequest[];
  read: (request: ReadRequest) => Promise<ReadResult>;
};

/** Answers the list call with the given hits and every detail call with a match. */
function transportWith(listed: Array<{ id: string; threadId: string }>): FakeTransport {
  const calls: ReadRequest[] = [];
  return {
    calls,
    async read(request) {
      calls.push(request);
      if (/\/messages$/.test(request.endpoint)) {
        return { ok: true, status: 200, data: listed.length ? { messages: listed } : {} };
      }
      return {
        ok: true,
        status: 200,
        data: { id: listed[0]?.id ?? "unused", threadId: listed[0]?.threadId ?? "unused", payload: { headers: [] } },
      };
    },
  };
}

function failingTransport(): FakeTransport {
  const calls: ReadRequest[] = [];
  return {
    calls,
    async read(request) {
      calls.push(request);
      return { ok: false, code: "provider_error", status: 503, message: "The connected service returned 503." };
    },
  };
}

type Seeded = {
  auth: ReturnType<typeof ownerAuth>;
  workspaceId: string;
  proposalId: string;
  attemptId: string;
  startedAt: Date;
  connectedAccountId: string;
};

let counter = 0;

async function seedUnknown(options: {
  slug: string;
  startedAt: Date;
  status?: "unknown" | "succeeded";
  reconciliation?: "pending" | "not_needed" | "resolved";
  accountStatus?: "active" | "revoked";
}): Promise<Seeded> {
  counter += 1;
  const { userId, workspaceId } = await seedWorkspace(db, `${options.slug}-${Date.now()}-${counter}`);
  const auth = ownerAuth(userId, workspaceId);
  const alias = `recon-gmail-${counter}`;
  const connectedAccountId = options.accountStatus === "revoked" ? null : `ca_${crypto.randomUUID()}`;
  await db.insert(externalAccounts).values({
    workspaceId,
    provider: "gmail",
    alias,
    status: options.accountStatus ?? "active",
    composioConnectedAccountId: connectedAccountId,
    createdBy: userId,
    updatedBy: userId,
  });

  const [proposal] = await db
    .insert(actionProposals)
    .values({
      workspaceId,
      capability: "gmail.send",
      riskClass: "external_write",
      status: "approved",
      accountAlias: alias,
      title: "Send email to ada@example.test",
      expectedEffect: "Sends a message.",
      dedupeKey: `recon:${workspaceId}:${counter}`,
      decidedAt: options.startedAt,
      decidedBy: userId,
    })
    .returning();

  const [revision] = await db
    .insert(actionRevisions)
    .values({
      workspaceId,
      proposalId: proposal.id,
      revisionNumber: 1,
      payload: { to: "ada@example.test", subject: "Hi", body: "Hello", inReplyTo: null },
      createdBy: userId,
    })
    .returning();

  const [attempt] = await db
    .insert(actionAttempts)
    .values({
      workspaceId,
      proposalId: proposal.id,
      revisionId: revision.id,
      idempotencyKey: `exec:${proposal.id}`,
      attemptNumber: 1,
      status: options.status ?? "unknown",
      reconciliation: options.reconciliation ?? "pending",
      startedAt: options.startedAt,
    })
    .returning();

  return {
    auth,
    workspaceId,
    proposalId: proposal.id,
    attemptId: attempt.id,
    startedAt: options.startedAt,
    connectedAccountId: connectedAccountId ?? "",
  };
}

async function attemptRow(attemptId: string) {
  const [row] = await db.select().from(actionAttempts).where(eq(actionAttempts.id, attemptId));
  return row;
}

async function observations(attemptId: string) {
  return db
    .select()
    .from(providerObservations)
    .where(eq(providerObservations.attemptId, attemptId));
}

async function reconciledAudits(proposalId: string) {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.subjectId, proposalId), eq(auditEvents.action, "actions.effect_reconciled")));
}

/**
 * The sweep spans every workspace, and this suite shares one database, so an
 * assertion on the whole call list would be asserting on whichever row another
 * test left behind. Scoping to the account this test seeded is the honest
 * question: "did the sweep ask about *this* attempt?"
 */
function callsFor(transport: FakeTransport, connectedAccountId: string) {
  return transport.calls.filter((call) => call.connectedAccountId === connectedAccountId);
}

suite("reconcileUnknownAttempts (real Postgres)", () => {
  it("settles succeeded with the provider id when the marker is found", async () => {
    const seeded = await seedUnknown({ slug: "recon-found", startedAt: new Date(Date.now() - 60_000) });
    const transport = transportWith([{ id: "msg_found", threadId: "thr_found" }]);

    const result = await reconciliation.reconcileUnknownAttempts({ transport });
    expect(result.reconciled).toBeGreaterThanOrEqual(1);

    const row = await attemptRow(seeded.attemptId);
    expect(row.status).toBe("succeeded");
    expect(row.reconciliation).toBe("resolved");
    expect(row.providerObjectId).toBe("msg_found");
    expect(row.endedAt).not.toBeNull();

    // The search asked Gmail for the attempt's own marker.
    expect(callsFor(transport, seeded.connectedAccountId)[0]).toMatchObject({
      method: "GET",
      query: { q: `rfc822msgid:${send.messageIdMarker(seeded.attemptId)}` },
    });

    const [observation] = await observations(seeded.attemptId);
    expect(observation.observedState).toBe("sent");
    expect(observation.providerObjectId).toBe("msg_found");

    const audits = await reconciledAudits(seeded.proposalId);
    expect(audits).toHaveLength(1);
    expect(audits[0].actorKind).toBe("system");
  });

  it("settles failed when absence is older than the index lag", async () => {
    const startedAt = new Date(Date.now() - reconciliation.RECONCILIATION_LAG_MS - 60_000);
    const seeded = await seedUnknown({ slug: "recon-absent-old", startedAt });
    const transport = transportWith([]);

    await reconciliation.reconcileUnknownAttempts({ transport });

    const row = await attemptRow(seeded.attemptId);
    expect(row.status).toBe("failed");
    expect(row.reconciliation).toBe("resolved");
    expect(row.errorCode).toBe("reconciled_absent");

    const [observation] = await observations(seeded.attemptId);
    expect(observation.observedState).toBe("absent");
    expect(await reconciledAudits(seeded.proposalId)).toHaveLength(1);

    // Reconciliation never retries the send: one search, no write to the send endpoint.
    expect(callsFor(transport, seeded.connectedAccountId).every((call) => call.method === "GET")).toBe(true);
  });

  it("leaves the row unknown when absence is inside the lag window", async () => {
    const startedAt = new Date(Date.now() - 5 * 60_000);
    const seeded = await seedUnknown({ slug: "recon-absent-young", startedAt });
    const transport = transportWith([]);

    await reconciliation.reconcileUnknownAttempts({ transport });

    const row = await attemptRow(seeded.attemptId);
    expect(row.status).toBe("unknown");
    expect(row.reconciliation).toBe("pending");
    expect(row.endedAt).toBeNull();
    expect(await observations(seeded.attemptId)).toHaveLength(0);
    expect(await reconciledAudits(seeded.proposalId)).toHaveLength(0);
  });

  it("leaves the row untouched on a transport error", async () => {
    // Old enough that a *successful* empty search would have settled `failed`.
    const startedAt = new Date(Date.now() - reconciliation.RECONCILIATION_LAG_MS - 60_000);
    const seeded = await seedUnknown({ slug: "recon-error", startedAt });
    const transport = failingTransport();

    await reconciliation.reconcileUnknownAttempts({ transport });

    const row = await attemptRow(seeded.attemptId);
    expect(row.status).toBe("unknown");
    expect(row.reconciliation).toBe("pending");
    expect(await observations(seeded.attemptId)).toHaveLength(0);
    expect(await reconciledAudits(seeded.proposalId)).toHaveLength(0);
  });

  it("never selects a succeeded attempt", async () => {
    const seeded = await seedUnknown({
      slug: "recon-succeeded",
      startedAt: new Date(Date.now() - 60_000),
      status: "succeeded",
      reconciliation: "not_needed",
    });
    const transport = transportWith([{ id: "msg_forged", threadId: "thr_forged" }]);

    await reconciliation.reconcileUnknownAttempts({ transport });

    const row = await attemptRow(seeded.attemptId);
    expect(row.status).toBe("succeeded");
    expect(row.providerObjectId).toBeNull();
    expect(callsFor(transport, seeded.connectedAccountId)).toHaveLength(0);
  });

  it("settles once: a second pass writes no observation and no audit", async () => {
    const seeded = await seedUnknown({ slug: "recon-twice", startedAt: new Date(Date.now() - 60_000) });
    const transport = transportWith([{ id: "msg_once", threadId: "thr_once" }]);

    await reconciliation.reconcileUnknownAttempts({ transport });
    const afterFirst = callsFor(transport, seeded.connectedAccountId).length;
    expect(afterFirst).toBeGreaterThan(0);
    const second = await reconciliation.reconcileUnknownAttempts({ transport });

    const row = await attemptRow(seeded.attemptId);
    expect(row.status).toBe("succeeded");
    expect(row.reconciliation).toBe("resolved");
    expect(second.reconciled).toBe(0);
    expect(await observations(seeded.attemptId)).toHaveLength(1);
    expect(await reconciledAudits(seeded.proposalId)).toHaveLength(1);
    // `resolved` removes the row from the sweep: the second pass asks nothing.
    expect(callsFor(transport, seeded.connectedAccountId)).toHaveLength(afterFirst);
  });

  it("leaves the row alone when the account can no longer be read through", async () => {
    const startedAt = new Date(Date.now() - reconciliation.RECONCILIATION_LAG_MS - 60_000);
    const seeded = await seedUnknown({ slug: "recon-revoked", startedAt, accountStatus: "revoked" });
    const transport = transportWith([]);

    await reconciliation.reconcileUnknownAttempts({ transport });

    const row = await attemptRow(seeded.attemptId);
    expect(row.status).toBe("unknown");
    expect(row.reconciliation).toBe("pending");
    expect(callsFor(transport, seeded.connectedAccountId)).toHaveLength(0);
  });
});
