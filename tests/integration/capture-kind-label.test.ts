import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captures } from "@/domains/capture/schema";
import type { JevClient } from "@/integrations/jev/client";
import type { ClassifyJudger, JevJudgeInput } from "@/integrations/jev/provider";
import type { ProviderEntry } from "@/integrations/providers/registry";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Every capture gets a kind label: the free rules decide first, Jev settles
 * the rest, and the person's correction wins over both. Runs against a real
 * scratch Postgres with fake Jev clients (no live calls).
 *
 * Import discipline (as in jev-classify.test.ts): modules that reach
 * @/lib/db are lazy-imported after makeTestDb points DATABASE_URL at the
 * scratch database.
 */

const authHolder: { ctx: { userId: string; workspaceId: string; role: "owner" } } = {
  ctx: { userId: "none", workspaceId: "none", role: "owner" },
};
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => authHolder.ctx) }));

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let labelCaptureKind: typeof import("@/domains/capture/kind-label").labelCaptureKind;
let jevClassifier: typeof import("@/integrations/jev/provider").jevClassifier;
let drizzleQuotaStore: typeof import("@/integrations/providers/quota").drizzleQuotaStore;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  ({ labelCaptureKind } = await import("@/domains/capture/kind-label"));
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

const AMBIGUOUS = "Maybe the onboarding flow should start from the person's first capture instead of a tour.";

/** A judger that answers the kind question with `choice` and counts its calls. */
function fakeJudger(choice: string, probability = 0.82): ClassifyJudger & { calls: JevJudgeInput[] } {
  return {
    calls: [],
    async judge(input) {
      this.calls.push(input);
      return {
        model: "jev-1.14.0",
        answers: {
          kind: { type: "choice", choice, confidence: probability, probabilities: { [choice]: probability } },
        },
        usage: { input_tokens: 40, output_tokens: 4 },
      };
    },
  };
}

async function insertTextCapture(workspaceId: string, text: string) {
  const [row] = await db
    .insert(captures)
    .values({
      workspaceId,
      kind: "text",
      source: "quick_capture",
      captureMode: "authored",
      rawPayload: { text },
      text,
      processingState: "unprocessed",
    })
    .returning({ id: captures.id });
  return row.id;
}

async function insertUrlCapture(workspaceId: string, url: string) {
  const [row] = await db
    .insert(captures)
    .values({
      workspaceId,
      kind: "url",
      source: "quick_capture",
      captureMode: "url-reference",
      rawPayload: { url },
      url,
      structure: "url",
      processingState: "enriched",
    })
    .returning({ id: captures.id });
  return row.id;
}

async function insertPageCapture(workspaceId: string, url: string, text: string, fetchedText: string) {
  const [row] = await db
    .insert(captures)
    .values({
      workspaceId,
      kind: "url",
      source: "quick_capture",
      captureMode: "page",
      rawPayload: { url, text },
      url,
      text,
      fetchedText,
      fetchOutcome: "acquired",
      processingState: "enriched",
    })
    .returning({ id: captures.id });
  return row.id;
}

/** A real jevClassifier with an enabled entry, in an env missing what `env` leaves out. */
function classifierWith(workspaceId: string, env: Record<string, string>, client?: JevClient) {
  return jevClassifier(workspaceId, { entry: ENABLED_ENTRY, client, quotaStore: drizzleQuotaStore(db as never), env });
}

const PAGE = "A long essay on pricing pages, how teams test them, and what the numbers showed over two years.";

async function readKind(captureId: string) {
  const [row] = await db
    .select({ label: captures.kindLabel, reason: captures.kindReason, source: captures.kindSource })
    .from(captures)
    .where(eq(captures.id, captureId));
  return row;
}

suite("capture kind label", () => {
  it("rules settle a bare URL without asking Jev", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `kind-${Date.now()}-url`);
    const captureId = await insertUrlCapture(workspaceId, "https://example.com/essay");
    const judger = fakeJudger("idea");

    const result = await labelCaptureKind({ userId, workspaceId, role: "owner" }, captureId, { judger });

    expect(result).toEqual({ kind: "article", source: "rules", skipped: null });
    expect(judger.calls).toHaveLength(0);
    const row = await readKind(captureId);
    expect(row.label).toBe("article");
    expect(row.source).toBe("rules");
    expect(row.reason).toBeTruthy();
  });

  it("ambiguous text asks Jev and stores its answer with source jev", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `kind-${Date.now()}-jev`);
    const captureId = await insertTextCapture(workspaceId, AMBIGUOUS);
    const judger = fakeJudger("idea");

    const result = await labelCaptureKind({ userId, workspaceId, role: "owner" }, captureId, { judger });

    expect(result).toEqual({ kind: "idea", source: "jev", skipped: null });
    expect(judger.calls).toHaveLength(1);
    expect(Object.keys(judger.calls[0].questions)).toEqual(["kind"]);
    const row = await readKind(captureId);
    expect(row.label).toBe("idea");
    expect(row.source).toBe("jev");
  });

  it("enrichment labels a capture after the rules tier", async () => {
    const { workspaceId } = await seedWorkspace(db, `kind-${Date.now()}-ladder`);
    const captureId = await insertTextCapture(workspaceId, AMBIGUOUS);
    const judger = fakeJudger("idea");

    const { runCaptureEnrichment } = await import("@/domains/capture/enrichment-handler");
    await runCaptureEnrichment({ workspaceId, payload: { captureId } } as never, { judger });

    const row = await readKind(captureId);
    expect(row.label).toBe("idea");
    expect(row.source).toBe("jev");
  });

  it("a link with the person's own words is labeled by those words, not as an article", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `kind-${Date.now()}-page`);
    const auth = { userId, workspaceId, role: "owner" as const };
    const url = "https://example.com/pricing";

    const todo = await insertPageCapture(workspaceId, url, "Call Dana about this by Friday", PAGE);
    const ruleJudger = fakeJudger("article");
    expect(await labelCaptureKind(auth, todo, { judger: ruleJudger })).toEqual({
      kind: "task",
      source: "rules",
      skipped: null,
    });
    expect(ruleJudger.calls).toHaveLength(0);

    const note = await insertPageCapture(workspaceId, url, "Use this layout for our own pricing page", PAGE);
    const judger = fakeJudger("idea");
    expect(await labelCaptureKind(auth, note, { judger })).toEqual({ kind: "idea", source: "jev", skipped: null });
    expect(judger.calls).toHaveLength(1);
    expect(JSON.parse(judger.calls[0].state)).toMatchObject({
      text: PAGE,
      note: "Use this layout for our own pricing page",
    });
  });

  it("without Jev (no key, or no allowance) the capture reads Not classified with a reason", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `kind-${Date.now()}-nojev`);
    const auth = { userId, workspaceId, role: "owner" as const };
    const client: JevClient & { calls: number } = {
      calls: 0,
      async systemOne() {
        this.calls += 1;
        throw new Error("no request should be made without an allowance");
      },
    };
    const cases = [
      classifierWith(workspaceId, { JEV_MONTHLY_INPUT_TOKENS: "100000" }),
      classifierWith(workspaceId, { TYPESAFE_API_KEY: "k" }, client),
      classifierWith(workspaceId, { TYPESAFE_API_KEY: "k", JEV_MONTHLY_INPUT_TOKENS: "0" }, client),
    ];
    for (const judger of cases) {
      const captureId = await insertTextCapture(workspaceId, AMBIGUOUS);
      expect(await labelCaptureKind(auth, captureId, { judger })).toEqual({
        kind: null,
        source: null,
        skipped: "disabled",
      });
      expect(await readKind(captureId)).toEqual({
        label: null,
        source: null,
        reason: "Not classified automatically here. Set it by hand.",
      });
    }
    expect(client.calls).toBe(0);
  });

  it("an edit the rules no longer settle clears the old automatic label", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `kind-${Date.now()}-stale`);
    const auth = { userId, workspaceId, role: "owner" as const };
    const captureId = await insertTextCapture(workspaceId, "- [ ] buy milk");
    expect(await labelCaptureKind(auth, captureId)).toMatchObject({ kind: "task", source: "rules" });

    await db.update(captures).set({ text: "Milk is cheaper at the corner shop." }).where(eq(captures.id, captureId));
    const result = await labelCaptureKind(auth, captureId, {
      judger: classifierWith(workspaceId, { JEV_MONTHLY_INPUT_TOKENS: "100000" }),
    });

    expect(result).toEqual({ kind: null, source: null, skipped: "disabled" });
    expect(await readKind(captureId)).toEqual({
      label: null,
      source: null,
      reason: "Not classified automatically here. Set it by hand.",
    });
  });

  it("a spent quota clears the earlier Jev label, keeps the reason and reports the budget", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `kind-${Date.now()}-budget`);
    const captureId = await insertTextCapture(workspaceId, AMBIGUOUS);
    await labelCaptureKind({ userId, workspaceId, role: "owner" }, captureId, { judger: fakeJudger("idea") });
    expect(await readKind(captureId)).toMatchObject({ label: "idea", source: "jev" });
    const client: JevClient & { calls: number } = {
      calls: 0,
      async systemOne() {
        this.calls += 1;
        throw new Error("the quota should refuse before any request");
      },
    };
    // An allowance of one token cannot cover any request's reservation.
    const judger = jevClassifier(workspaceId, {
      entry: ENABLED_ENTRY,
      client,
      quotaStore: drizzleQuotaStore(db as never),
      env: { TYPESAFE_API_KEY: "k", JEV_MONTHLY_INPUT_TOKENS: "1" },
    });

    const result = await labelCaptureKind({ userId, workspaceId, role: "owner" }, captureId, { judger });

    expect(result).toEqual({ kind: null, source: null, skipped: "budget" });
    expect(client.calls).toBe(0);
    const row = await readKind(captureId);
    expect(row.label).toBeNull();
    expect(row.source).toBeNull();
    expect(row.reason).toBe("Classification budget used this month — set it by hand.");
  });

  it("the person's correction is stored with source user and enrichment never overwrites it", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `kind-${Date.now()}-user`);
    authHolder.ctx = { userId, workspaceId, role: "owner" };
    const captureId = await insertTextCapture(workspaceId, AMBIGUOUS);

    const { setCaptureKindAction } = await import("@/app/(workspace)/command-center/inbox/actions");
    expect(await setCaptureKindAction({ captureId, kind: "task" })).toEqual({ ok: true });
    expect(await readKind(captureId)).toMatchObject({ label: "task", source: "user" });

    const judger = fakeJudger("idea");
    const direct = await labelCaptureKind({ userId, workspaceId, role: "owner" }, captureId, { judger });
    expect(direct).toEqual({ kind: "task", source: "user", skipped: null });

    const { runCaptureEnrichment } = await import("@/domains/capture/enrichment-handler");
    await runCaptureEnrichment({ workspaceId, payload: { captureId } } as never, { judger });

    expect(judger.calls).toHaveLength(0);
    expect(await readKind(captureId)).toMatchObject({ label: "task", source: "user" });
  });

  it("refuses a kind outside the list and a capture from another workspace", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `kind-${Date.now()}-guard`);
    const other = await seedWorkspace(db, `kind-${Date.now()}-other`);
    const foreignId = await insertTextCapture(other.workspaceId, AMBIGUOUS);
    authHolder.ctx = { userId, workspaceId, role: "owner" };

    const { setCaptureKindAction } = await import("@/app/(workspace)/command-center/inbox/actions");
    expect((await setCaptureKindAction({ captureId: foreignId, kind: "task" })).ok).toBe(false);
    expect((await setCaptureKindAction({ captureId: foreignId, kind: "recipe" as never })).ok).toBe(false);
    expect(await readKind(foreignId)).toMatchObject({ label: null, source: null });
  });
});
