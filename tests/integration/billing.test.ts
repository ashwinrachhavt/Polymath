import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEvents } from "@/domains/audit/schema";
import { DEFAULT_MODEL_ID, MODEL_CATALOG, modelById } from "@/domains/agents/models";
import { modelUsageLedger, workspaceModelKeys, workspacePlans } from "@/domains/billing/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Value: protects=the one rule for who pays for a model call (own key, else
 * house under a weekly allowance, else a clear stop), keys never leaking, and
 * every call landing in the ledger; fails_when=a workspace with a key bills the
 * house, an exhausted free workspace still reaches a house key, a saved key is
 * readable from the row or the masked view, a rejected key is stored, or a
 * stubbed call writes no priced ledger row; seam=the real resolver, key store,
 * ledger and Postgres, with fetch stubbed at the provider boundary;
 * no_claim=that any provider accepts these requests (stubs stand in; the live
 * probe happens when a person adds a key).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let resolver: typeof import("@/domains/billing/resolver");
let keys: typeof import("@/domains/billing/keys");
let ledger: typeof import("@/domains/billing/ledger");
let plans: typeof import("@/domains/billing/plans");

const ENV = {
  SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  // The house keys for the default model and for Groq (the generation chain's first key).
  [modelById(DEFAULT_MODEL_ID)!.keyEnv]: "house-default-key",
  GROQ_API_KEY: "house-groq-key",
};

const ok = () => Promise.resolve(new Response("{}", { status: 200 }));
const status = (code: number) => () => Promise.resolve(new Response("{}", { status: code }));

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  resolver = await import("@/domains/billing/resolver");
  keys = await import("@/domains/billing/keys");
  ledger = await import("@/domains/billing/ledger");
  plans = await import("@/domains/billing/plans");
});

afterAll(async () => {
  await handle?.client.end();
});

async function workspace(label: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `bill-${label}-${Date.now()}`);
  return { workspaceId, auth: ownerAuth(userId, workspaceId) };
}

async function fillHouseWeek(workspaceId: string, calls: number) {
  await db.insert(modelUsageLedger).values(
    Array.from({ length: calls }, () => ({
      workspaceId,
      purpose: "chat",
      provider: "thehive",
      model: DEFAULT_MODEL_ID,
      keySource: "house",
    })),
  );
}

suite("resolver precedence", () => {
  it("serves the house key to a workspace with no key of its own", async () => {
    const { workspaceId } = await workspace("house");
    const route = await resolver.resolveModelRoute(workspaceId, DEFAULT_MODEL_ID, "chat", ENV);
    expect(route.source).toBe("house");
    expect(route.option.id).toBe(DEFAULT_MODEL_ID);
    expect(route.apiKey).toBe("house-default-key");
  });

  it("prefers the workspace's own key, on the requested model when the provider matches", async () => {
    const { workspaceId, auth } = await workspace("own");
    await keys.saveWorkspaceKey(
      auth,
      { provider: "thehive", apiKey: "user-thehive-key-9999" },
      { fetchImpl: ok, env: ENV },
    );
    const route = await resolver.resolveModelRoute(workspaceId, DEFAULT_MODEL_ID, "chat", ENV);
    expect(route.source).toBe("own");
    expect(route.option.id).toBe(DEFAULT_MODEL_ID);
    expect(route.apiKey).toBe("user-thehive-key-9999");
  });

  it("serves another provider's cheapest model on the own key, never the house's, when the request named a different provider", async () => {
    const { workspaceId, auth } = await workspace("sub");
    await keys.saveWorkspaceKey(
      auth,
      { provider: "openai", apiKey: "user-openai-key-4242" },
      { fetchImpl: ok, env: ENV },
    );
    const route = await resolver.resolveModelRoute(workspaceId, DEFAULT_MODEL_ID, "chat", ENV);
    expect(route.source).toBe("own");
    expect(route.option.provider).toBe("openai");
    expect(route.option.id).toBe("gpt-5.4-mini");
    expect(route.apiKey).toBe("user-openai-key-4242");
  });

  it("freezes the model a run will actually be served, not the one requested", async () => {
    const { workspaceId, auth } = await workspace("freeze");
    expect(await resolver.resolveRunModelFor(workspaceId, null, ENV)).toBe(DEFAULT_MODEL_ID);
    await keys.saveWorkspaceKey(
      auth,
      { provider: "anthropic", apiKey: "user-claude-key-0001" },
      { fetchImpl: ok, env: ENV },
    );
    expect(await resolver.resolveRunModelFor(workspaceId, null, ENV)).toBe("claude-haiku-5-5");
  });

  it("still creates a run on a deployment with no house key, leaving the missing key to the first step", async () => {
    const { workspaceId } = await workspace("keyless");
    expect(await resolver.resolveRunModelFor(workspaceId, null, {})).toBe(DEFAULT_MODEL_ID);
  });

  it("refuses to start a run for a free workspace whose allowance is gone", async () => {
    const { workspaceId } = await workspace("startcap");
    await fillHouseWeek(workspaceId, plans.FREE_WEEKLY_AI_CALLS);
    await expect(resolver.resolveRunModelFor(workspaceId, null, ENV)).rejects.toBeInstanceOf(
      resolver.AllowanceExhaustedError,
    );
  });

  it("offers the picker the models its own keys can serve", async () => {
    const { workspaceId, auth } = await workspace("picker");
    const before = (await resolver.selectableModels(workspaceId, {})).map((m) => m.id);
    expect(before).toEqual([]);
    await keys.saveWorkspaceKey(
      auth,
      { provider: "anthropic", apiKey: "user-claude-key-0002" },
      { fetchImpl: ok, env: ENV },
    );
    const after = (await resolver.selectableModels(workspaceId, {})).map((m) => m.id);
    expect(after).toEqual(MODEL_CATALOG.filter((m) => m.provider === "anthropic").map((m) => m.id));
  });

  it("says plainly when the house has no key for the model", async () => {
    const { workspaceId } = await workspace("nohouse");
    await expect(resolver.resolveModelRoute(workspaceId, DEFAULT_MODEL_ID, "chat", {})).rejects.toThrow(/is not set/);
  });
});

suite("the weekly allowance", () => {
  it("stops a free workspace at the cap with a message that says what to do", async () => {
    const { workspaceId } = await workspace("cap");
    await fillHouseWeek(workspaceId, plans.FREE_WEEKLY_AI_CALLS - 1);
    await expect(resolver.resolveModelRoute(workspaceId, DEFAULT_MODEL_ID, "chat", ENV)).resolves.toMatchObject({
      source: "house",
    });
    await fillHouseWeek(workspaceId, 1);
    const stop = resolver.resolveModelRoute(workspaceId, DEFAULT_MODEL_ID, "chat", ENV);
    await expect(stop).rejects.toBeInstanceOf(resolver.AllowanceExhaustedError);
    await expect(stop).rejects.toThrow(/add your own key.*upgrade to Pro/i);
  });

  it("counts generation calls too, through the same check", async () => {
    const { workspaceId } = await workspace("capgen");
    await fillHouseWeek(workspaceId, plans.FREE_WEEKLY_AI_CALLS);
    await expect(resolver.resolveGeneration(workspaceId, "generation", { env: ENV })).rejects.toBeInstanceOf(
      resolver.AllowanceExhaustedError,
    );
  });

  it("never lets an exhausted workspace's own key be limited", async () => {
    const { workspaceId, auth } = await workspace("capown");
    await fillHouseWeek(workspaceId, plans.FREE_WEEKLY_AI_CALLS + 5);
    await keys.saveWorkspaceKey(
      auth,
      { provider: "thehive", apiKey: "user-thehive-key-1111" },
      { fetchImpl: ok, env: ENV },
    );
    await expect(resolver.resolveModelRoute(workspaceId, DEFAULT_MODEL_ID, "chat", ENV)).resolves.toMatchObject({
      source: "own",
    });
  });

  it("gives Pro the larger allowance once set by the owner", async () => {
    const { workspaceId, auth } = await workspace("pro");
    await fillHouseWeek(workspaceId, plans.FREE_WEEKLY_AI_CALLS);
    await expect(resolver.resolveModelRoute(workspaceId, DEFAULT_MODEL_ID, "chat", ENV)).rejects.toBeInstanceOf(
      resolver.AllowanceExhaustedError,
    );
    expect(await plans.setProByOwner(auth, true)).toBe("pro");
    await expect(resolver.resolveModelRoute(workspaceId, DEFAULT_MODEL_ID, "chat", ENV)).resolves.toMatchObject({
      source: "house",
    });
    const status = await ledger.allowanceStatus(workspaceId);
    expect(status).toMatchObject({
      plan: "pro",
      used: plans.FREE_WEEKLY_AI_CALLS,
      allowance: plans.PRO_WEEKLY_AI_CALLS,
    });
  });

  it("keeps the manual Pro switch to workspace owners and audits it", async () => {
    const { workspaceId, auth } = await workspace("proguard");
    await expect(plans.setProByOwner({ ...auth, role: "member" }, true)).rejects.toThrow(/Requires owner/);
    await plans.setProByOwner(auth, true);
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, workspaceId));
    expect(audit.map((row) => row.action)).toContain("workspace_plan.changed");
  });

  it("exempts embeddings from the allowance", async () => {
    const { workspaceId } = await workspace("embed");
    await fillHouseWeek(workspaceId, plans.FREE_WEEKLY_AI_CALLS + 10);
    await expect(resolver.resolveModelRoute(workspaceId, DEFAULT_MODEL_ID, "embedding", ENV)).resolves.toMatchObject({
      source: "house",
    });
  });

  it("does not count last week's calls", async () => {
    const { workspaceId } = await workspace("lastweek");
    await fillHouseWeek(workspaceId, plans.FREE_WEEKLY_AI_CALLS);
    const nextWeek = new Date(plans.currentWeek().resetsAt.getTime() + 60_000);
    expect(await ledger.houseCallsThisWeek(workspaceId, nextWeek)).toBe(0);
  });
});

suite("keys: redaction, validation, plan", () => {
  it("stores the key sealed, shows only the last four, and never returns it", async () => {
    const { workspaceId, auth } = await workspace("redact");
    const secret = "sk-live-SECRETVALUE-7788";
    const saved = await keys.saveWorkspaceKey(
      auth,
      { provider: "openai", apiKey: ` ${secret} ` },
      { fetchImpl: ok, env: ENV },
    );
    expect(saved).toMatchObject({ provider: "openai", last4: "7788" });
    expect(JSON.stringify(saved)).not.toContain("SECRETVALUE");

    const status = await keys.listKeyStatus(workspaceId);
    expect(status).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain("SECRETVALUE");

    const [row] = await db.select().from(workspaceModelKeys).where(eq(workspaceModelKeys.workspaceId, workspaceId));
    expect(row.sealedKey).not.toContain("SECRETVALUE");
    expect(row.last4).toBe("7788");

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, workspaceId));
    expect(JSON.stringify(audit)).not.toContain("SECRETVALUE");
  });

  it("will not open another workspace's key", async () => {
    const a = await workspace("iso-a");
    const b = await workspace("iso-b");
    await keys.saveWorkspaceKey(
      a.auth,
      { provider: "groq", apiKey: "user-groq-key-5555" },
      { fetchImpl: ok, env: ENV },
    );
    expect(await keys.loadOwnKeys(b.workspaceId, ENV)).toEqual([]);
    const [row] = await db.select().from(workspaceModelKeys).where(eq(workspaceModelKeys.workspaceId, a.workspaceId));
    await db.update(workspaceModelKeys).set({ workspaceId: b.workspaceId }).where(eq(workspaceModelKeys.id, row.id));
    await expect(keys.loadOwnKeys(b.workspaceId, ENV)).rejects.toThrow(/could not be opened/);
  });

  it("refuses a key the provider rejects, an unreachable provider, and a deployment without an encryption key", async () => {
    const { workspaceId, auth } = await workspace("reject");
    await expect(
      keys.saveWorkspaceKey(auth, { provider: "openai", apiKey: "bad-key-0000" }, { fetchImpl: status(401), env: ENV }),
    ).rejects.toThrow(/rejected this key/);
    await expect(
      keys.saveWorkspaceKey(auth, { provider: "openai", apiKey: "key-1234" }, { fetchImpl: status(503), env: ENV }),
    ).rejects.toThrow(/Try again/);
    await expect(
      keys.saveWorkspaceKey(auth, { provider: "openai", apiKey: "key-1234" }, { fetchImpl: status(429), env: ENV }),
    ).rejects.toThrow(/no credit or is rate-limited/);
    await expect(
      keys.saveWorkspaceKey(auth, { provider: "openai", apiKey: "key-1234" }, { fetchImpl: ok, env: {} }),
    ).rejects.toThrow(/SECRETS_ENCRYPTION_KEY/);
    await expect(
      keys.saveWorkspaceKey(auth, { provider: "not-a-provider", apiKey: "key-1234" }, { fetchImpl: ok, env: ENV }),
    ).rejects.toThrow(/not supported/);
    await expect(
      keys.saveWorkspaceKey(auth, { provider: "openai", apiKey: "has space" }, { fetchImpl: ok, env: ENV }),
    ).rejects.toThrow(/does not look like an API key/);
    expect(await keys.listKeyStatus(workspaceId)).toEqual([]);
  });

  it("keeps key changes to the owner", async () => {
    const { auth } = await workspace("owneronly");
    const member = { ...auth, role: "member" as const };
    await expect(
      keys.saveWorkspaceKey(member, { provider: "openai", apiKey: "key-1234" }, { fetchImpl: ok, env: ENV }),
    ).rejects.toThrow(/Requires owner/);
    await expect(keys.deleteWorkspaceKey(member, "openai")).rejects.toThrow(/Requires owner/);
  });

  it("moves free to own-key on the first key, back on the last removal, and leaves Pro alone", async () => {
    const { workspaceId, auth } = await workspace("plan");
    const plan = async () =>
      (await db.select().from(workspacePlans).where(eq(workspacePlans.workspaceId, workspaceId)))[0]?.plan ?? "free";
    expect(await plan()).toBe("free");
    await keys.saveWorkspaceKey(auth, { provider: "openai", apiKey: "key-aaaa" }, { fetchImpl: ok, env: ENV });
    await keys.saveWorkspaceKey(auth, { provider: "groq", apiKey: "key-bbbb" }, { fetchImpl: ok, env: ENV });
    expect(await plan()).toBe("own-key");
    await keys.deleteWorkspaceKey(auth, "openai");
    expect(await plan()).toBe("own-key");
    await keys.deleteWorkspaceKey(auth, "groq");
    expect(await plan()).toBe("free");

    await plans.setProByOwner(auth, true);
    await keys.saveWorkspaceKey(auth, { provider: "openai", apiKey: "key-cccc" }, { fetchImpl: ok, env: ENV });
    await keys.deleteWorkspaceKey(auth, "openai");
    expect(await plan()).toBe("pro");
  });

  it("replaces a provider's key on re-save rather than adding a second", async () => {
    const { workspaceId, auth } = await workspace("replace");
    await keys.saveWorkspaceKey(auth, { provider: "groq", apiKey: "first-key-1111" }, { fetchImpl: ok, env: ENV });
    await keys.saveWorkspaceKey(auth, { provider: "groq", apiKey: "second-key-2222" }, { fetchImpl: ok, env: ENV });
    expect(await keys.loadOwnKeys(workspaceId, ENV)).toEqual([{ provider: "groq", apiKey: "second-key-2222" }]);
  });
});

suite("the usage ledger", () => {
  const completion = (usage = { prompt_tokens: 1200, completion_tokens: 300 }) =>
    (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage }), {
        status: 200,
      })) as typeof fetch;

  it("records a house call with workspace, model, tokens, source and a price", async () => {
    const { workspaceId } = await workspace("ledger-house");
    const provider = await resolver.resolveGeneration(workspaceId, "generation", { env: ENV, fetchImpl: completion() });
    await provider.generate({ prompt: "hi", json: true });
    const rows = await db.select().from(modelUsageLedger).where(eq(modelUsageLedger.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "generation",
      provider: "groq",
      model: "openai/gpt-oss-120b",
      keySource: "house",
      inputTokens: 1200,
      outputTokens: 300,
    });
    // 1200 in at $0.15/M + 300 out at $0.75/M.
    expect(Number(rows[0].costUsd)).toBeCloseTo((1200 * 0.15 + 300 * 0.75) / 1_000_000, 8);
    expect(await ledger.houseCallsThisWeek(workspaceId)).toBe(1);
  });

  it("records an own-key call as own, on the user's provider and model, outside the allowance", async () => {
    const { workspaceId, auth } = await workspace("ledger-own");
    await keys.saveWorkspaceKey(
      auth,
      { provider: "anthropic", apiKey: "user-claude-key-3333" },
      { fetchImpl: ok, env: ENV },
    );
    const provider = await resolver.resolveGeneration(workspaceId, "grading", { env: ENV, fetchImpl: completion() });
    expect(provider.registryId).toBe("own:anthropic");
    await provider.generate({ prompt: "hi", json: true });
    const rows = await db.select().from(modelUsageLedger).where(eq(modelUsageLedger.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "grading",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      keySource: "own",
    });
    expect(Number(rows[0].costUsd)).toBeCloseTo((1200 * 1 + 300 * 5) / 1_000_000, 8);
    expect(await ledger.houseCallsThisWeek(workspaceId)).toBe(0);
  });

  it("leaves a call whose usage the provider did not report unpriced rather than free", async () => {
    const { workspaceId } = await workspace("ledger-unknown");
    await ledger.recordModelCall({
      workspaceId,
      purpose: "generation",
      provider: "groq",
      model: "openai/gpt-oss-120b",
      keySource: "house",
    });
    const [row] = await db.select().from(modelUsageLedger).where(eq(modelUsageLedger.workspaceId, workspaceId));
    expect(row.costUsd).toBeNull();
  });

  it("writes a replayed chat step once", async () => {
    const { workspaceId } = await workspace("ledger-replay");
    const step = {
      workspaceId,
      purpose: "chat" as const,
      provider: "thehive",
      model: DEFAULT_MODEL_ID,
      keySource: "house" as const,
      inputTokens: 10,
      outputTokens: 5,
      sourceRef: "run:turn:0",
    };
    await ledger.recordModelCall(step);
    await ledger.recordModelCall(step);
    expect(await db.select().from(modelUsageLedger).where(eq(modelUsageLedger.workspaceId, workspaceId))).toHaveLength(
      1,
    );
  });

  it("prices the default model, so its calls are never unpriced", async () => {
    const { workspaceId } = await workspace("ledger-default");
    await ledger.recordModelCall({
      workspaceId,
      purpose: "chat",
      provider: "thehive",
      model: DEFAULT_MODEL_ID,
      keySource: "house",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    const [row] = await db.select().from(modelUsageLedger).where(eq(modelUsageLedger.workspaceId, workspaceId));
    expect(Number(row.costUsd)).toBeGreaterThan(0);
  });
});
