import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureProposals, captures } from "@/domains/capture/schema";
import { documentClassificationProposals, documents, taxonomyNodes } from "@/domains/knowledge/schema";
import type { JevClient } from "@/integrations/jev/client";
import { JEV_QUESTIONS_VERSION } from "@/integrations/jev/questions";
import type { ProviderEntry } from "@/integrations/providers/registry";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Import discipline: anything that reaches @/lib/db (taxonomy.ts, the jev
 * provider, the quota store) must be lazy-imported AFTER makeTestDb has
 * pointed DATABASE_URL at the scratch database - top-level imports of those
 * modules bind the default URL at load time and fail auth in CI. Schema
 * files and pure modules are safe at the top.
 */

/*
 * Integration coverage for the ASH-272 Jev classifier against a real scratch
 * Postgres with a fake Jev client (no live calls, per the ticket): proposal
 * provenance, the review band, hallucinated-label rejection, seed
 * idempotency, the composite FK's tenant guard, the quota ledger's
 * reserve/settle rows, and the document dual-proposer.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let seedTaxonomyCatalog: typeof import("@/domains/knowledge/taxonomy").seedTaxonomyCatalog;
let jevClassifier: typeof import("@/integrations/jev/provider").jevClassifier;
let drizzleQuotaStore: typeof import("@/integrations/providers/quota").drizzleQuotaStore;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  ({ seedTaxonomyCatalog } = await import("@/domains/knowledge/taxonomy"));
  ({ jevClassifier } = await import("@/integrations/jev/provider"));
  ({ drizzleQuotaStore } = await import("@/integrations/providers/quota"));
});

afterAll(async () => {
  await handle?.client.end();
});

const ENABLED_ENTRY: ProviderEntry = {
  id: "jev",
  capability: "classify",
  freeClass: "unverified",
  enabled: true,
  allowPaidUsage: true,
  allowPaidFallback: false,
  sensitiveDataAllowed: false,
  quota: null,
  verifiedAt: "2026-10-25",
  verificationSource: "test",
  notes: "test entry",
};

const COMMITMENT_ANSWERS = {
  commitment: { type: "noul", noul: 0.9 },
  contact: { type: "noul", noul: 0.02 },
  reference: { type: "noul", noul: 0.11 },
  worthless: { type: "noul", noul: 0.01 },
  project: { type: "noul", noul: 0.05 },
  domain: { type: "choice", choice: "finance", confidence: 0.84, probabilities: { finance: 0.84 } },
};

function fakeJev(answers: Record<string, unknown>): JevClient & { calls: number } {
  return {
    calls: 0,
    async systemOne() {
      this.calls += 1;
      return { model: "jev-1.14.0", answers: answers as never, usage: { input_tokens: 500, output_tokens: 32 } };
    },
  };
}

function testJudger(workspaceId: string, client: JevClient) {
  return jevClassifier(workspaceId, {
    entry: ENABLED_ENTRY,
    client,
    quotaStore: drizzleQuotaStore(db as never),
    env: { TYPESAFE_API_KEY: "k", JEV_MONTHLY_INPUT_TOKENS: "100000" },
  });
}

async function insertCapture(workspaceId: string, text: string) {
  const [capture] = await db
    .insert(captures)
    .values({
      workspaceId,
      kind: "text" as const,
      source: "quick_capture" as const,
      rawPayload: { text },
      text,
      processingState: "unprocessed" as const,
    })
    .returning({ id: captures.id });
  return capture.id;
}

suite("jev capture triage (ASH-272)", () => {
  it("writes one pending task proposal with full provenance, and settles quota", async () => {
    const { workspaceId } = await seedWorkspace(db, `jev-${Date.now()}-a`);
    await seedTaxonomyCatalog(workspaceId, db as never);
    const captureId = await insertCapture(
      workspaceId,
      "Please send me the updated invoice by Friday so accounting can close the month. This is a real commitment with a deadline, long enough to clear the escalation threshold for the classifier tier without any doubt.",
    );
    const client = fakeJev(COMMITMENT_ANSWERS);

    const { runCaptureEnrichment } = await import("@/domains/capture/enrichment-handler");
    await runCaptureEnrichment(
      { workspaceId, payload: { captureId } } as never,
      { judger: testJudger(workspaceId, client) },
    );

    const proposals = await db
      .select()
      .from(captureProposals)
      .where(and(eq(captureProposals.captureId, captureId), eq(captureProposals.workspaceId, workspaceId)));
    expect(proposals).toHaveLength(1);
    const [proposal] = proposals;
    expect(proposal.kind).toBe("task");
    expect(proposal.status).toBe("pending");
    expect(proposal.rationale).toContain("commitment 0.90");
    expect(proposal.model).toBe("jev-1.14.0");
    expect(proposal.promptVersion).toBe(JEV_QUESTIONS_VERSION);
    expect(proposal.confidence).toBe("0.90");

    const [row] = await db.select().from(captures).where(eq(captures.id, captureId));
    expect(row.processingState).toBe("enriched");
    expect(row.domain).toBe("finance");

    // The ledger shows reserve + settle for the call (criterion 7).
    const ledger = await db.execute(
      `select kind from provider_usage_ledger where workspace_id = '${workspaceId}'::uuid order by created_at`,
    );
    const kinds = (ledger as unknown as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).toEqual(["reserve", "settle"]);
    expect(client.calls).toBe(1);
  });

  it("the all-band case produces exactly one low-confidence note proposal", async () => {
    const { workspaceId } = await seedWorkspace(db, `jev-${Date.now()}-b`);
    await seedTaxonomyCatalog(workspaceId, db as never);
    const captureId = await insertCapture(
      workspaceId,
      "Half thought, half reminder, genuinely ambiguous prose that is long enough to clear the tier gate easily and then some more words to be sure of it. This sentence only exists to carry the capture well past the two hundred and eighty character escalation threshold.",
    );
    const band = Object.fromEntries(
      ["commitment", "contact", "reference", "worthless", "project"].map((k) => [k, { type: "noul", noul: 0.5 }]),
    );

    const { runCaptureEnrichment } = await import("@/domains/capture/enrichment-handler");
    await runCaptureEnrichment(
      { workspaceId, payload: { captureId } } as never,
      { judger: testJudger(workspaceId, fakeJev(band)) },
    );

    const proposals = await db.select().from(captureProposals).where(eq(captureProposals.captureId, captureId));
    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("note");
    expect(proposals[0].confidence).toBe("low");
    expect(proposals[0].status).toBe("pending");
  });

  it("a hallucinated domain slug is never stored", async () => {
    const { workspaceId } = await seedWorkspace(db, `jev-${Date.now()}-c`);
    await seedTaxonomyCatalog(workspaceId, db as never);
    const captureId = await insertCapture(
      workspaceId,
      "Please review the quarterly numbers with me before the board meeting next week; I promised them a readout and owe them the updated figures by then, so this really cannot slip any further.",
    );

    const { runCaptureEnrichment } = await import("@/domains/capture/enrichment-handler");
    await runCaptureEnrichment(
      { workspaceId, payload: { captureId } } as never,
      {
        judger: testJudger(workspaceId, fakeJev({
          ...COMMITMENT_ANSWERS,
          domain: { type: "choice", choice: "alchemy", confidence: 0.99, probabilities: { alchemy: 0.99 } },
        })),
      },
    );

    const [row] = await db.select().from(captures).where(eq(captures.id, captureId));
    expect(row.domain).toBeNull();
    expect(row.processingState).toBe("enriched");
  });

  it("with no judger and no generation key the handler is byte-parity with the pre-ASH-272 behavior", async () => {
    const { workspaceId } = await seedWorkspace(db, `jev-${Date.now()}-g`);
    const text = "A long enough prose capture that would escalate to the model tier. ".repeat(8);
    const captureId = await insertCapture(workspaceId, text);

    const envBackup = { ...process.env };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const { runCaptureEnrichment } = await import("@/domains/capture/enrichment-handler");
      await runCaptureEnrichment({ workspaceId, payload: { captureId } } as never);
    } finally {
      process.env = envBackup;
    }

    const proposals = await db.select().from(captureProposals).where(eq(captureProposals.captureId, captureId));
    expect(proposals).toHaveLength(0); // no producer without Jev, as before
    const [row] = await db.select().from(captures).where(eq(captures.id, captureId));
    expect(row.processingState).toBe("enriched");
    expect(row.failureReason).toBeNull();
    expect(row.title).toBeNull();
    expect(row.domain).toBeNull();
  });

  it("taxonomy seeding is idempotent and exact: 10 L1 + 12 L2/L3 nodes", async () => {
    const { workspaceId } = await seedWorkspace(db, `jev-${Date.now()}-d`);
    await seedTaxonomyCatalog(workspaceId, db as never);
    await seedTaxonomyCatalog(workspaceId, db as never);
    const rows = await db.select().from(taxonomyNodes).where(eq(taxonomyNodes.workspaceId, workspaceId));
    expect(rows).toHaveLength(22);
    expect(rows.filter((r) => r.level === 1)).toHaveLength(10);
    expect(rows.filter((r) => r.level === 2)).toHaveLength(3);
    expect(rows.filter((r) => r.level === 3)).toHaveLength(9);
  });

  it("the composite FK rejects a child pointing at another workspace's parent", async () => {
    const { workspaceId: wsA } = await seedWorkspace(db, `jev-${Date.now()}-e1`);
    const { workspaceId: wsB } = await seedWorkspace(db, `jev-${Date.now()}-e2`);
    await seedTaxonomyCatalog(wsA, db as never);
    await expect(
      db.insert(taxonomyNodes).values({
        workspaceId: wsB,
        slug: "stolen-parent",
        displayName: "Stolen parent",
        level: 2,
        parentSlug: "ai", // exists in wsA, not wsB
      }),
    ).rejects.toThrow();
  });

  it("document side: rules-other triggers one jev@v1 proposal; statement/high spends nothing", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `jev-${Date.now()}-f`);
    const auth = ownerAuth(userId, workspaceId);
    const mod = await import("@/domains/knowledge/jev-classify");

    // Rules-uncertain document: the fake Jev says invoice, confidently.
    const [doc] = await db
      .insert(documents)
      .values({ workspaceId, title: "Mystery attachment", createdBy: userId })
      .returning({ id: documents.id });
    const client = fakeJev({
      docType: { type: "choice", choice: "invoice", confidence: 0.9, probabilities: { invoice: 0.9 } },
      docTypeFits: { type: "noul", noul: 0.95 },
    });
    const out = await mod.proposeJevClassification(
      auth,
      { documentId: doc.id, extractionId: null, text: "A document with no strong lexical signal at all.", fieldNames: [] },
      { judger: testJudger(workspaceId, client) },
    );
    expect(out.proposed).toBe(true);
    expect(out.docType).toBe("invoice");
    expect(client.calls).toBe(1);

    const proposals = await db
      .select()
      .from(documentClassificationProposals)
      .where(eq(documentClassificationProposals.documentId, doc.id));
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposer).toBe("jev@v1");
    expect(proposals[0].proposedType).toBe("invoice");
    expect(proposals[0].status).toBe("proposed");

    // A high-confidence bank statement: rules settle it, Jev never runs.
    const [statement] = await db
      .insert(documents)
      .values({ workspaceId, title: "March statement", createdBy: userId })
      .returning({ id: documents.id });
    const statementText = "Statement period 03/01-03/31. Beginning balance $1,000.00. Ending balance $900.00.";
    const settled = await mod.proposeJevClassification(
      auth,
      { documentId: statement.id, extractionId: null, text: statementText, fieldNames: [] },
      { judger: testJudger(workspaceId, client) },
    );
    expect(settled.proposed).toBe(false);
    expect(settled.skipped).toBe("settled");
    expect(client.calls).toBe(1); // unchanged: no spend on a settled verdict
  });
});
