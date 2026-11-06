import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentRuns, onboardingSessions } from "@/domains/agents/schema";
import { auditEvents } from "@/domains/audit/schema";
import { onboardingBriefSchema } from "@/domains/agents/onboarding-brief";
import { makeTestDb, seedWorkspace, truncateAll } from "../helpers/test-workspace";

/*
 * The detached wizard's actions. The contract under test: progress is the
 * session row (create-or-update, no run anywhere), the assist is gated like
 * the interview's start but is one awaited structured-output call whose
 * response contract is the reused onboardingBriefSchema, and a failure is
 * labelled — never a thrown boundary, never a second queue. The `ai` mock
 * validates its fake model output through the real schema the action passed
 * in, and the loopback fetch guard fails loudly if a real network call
 * sneaks through.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = {
  db: undefined,
};
const authHolder: { ctx: { userId: string; workspaceId: string; role: "owner" | "member" | "viewer" } } = {
  ctx: { userId: "none", workspaceId: "none", role: "owner" },
};
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => authHolder.ctx) }));
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

const generateObject = vi.fn(
  async (options: { schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } }) => {
    // The mock model composes a plausible brief; the schema the action passed
    // is the response contract, so the fake output is validated through it.
    const candidate = {
      agentName: "Pino's Own",
      role: "Precision engineer",
      tools: ["Notion", "Linear"],
      priorities: ["Ship the deslop wave", "Keep onboarding honest"],
    };
    const parsed = options.schema.safeParse(candidate);
    if (!parsed.success) throw new Error("mock model emitted an invalid brief");
    return { object: parsed.data };
  },
);
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: (...args: Parameters<typeof generateObject>) => generateObject(...args) };
});

import {
  markOnboardingWelcomedAction,
  refineOnboardingDraftAction,
  saveOnboardingProgressAction,
} from "@/app/(workspace)/onboarding/actions";

const freeform = {
  role: "Precision engineer",
  tools: ["Notion", "Linear"],
  priorities: ["Ship the deslop wave"],
  freeform: "I build precision tools for one-person teams; keep the agent's voice warm.",
};

beforeAll(async () => {
  holder.db = handle?.db;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});

suite("onboarding wizard actions", () => {
  it("persists progress as the session row: creates once, then updates the same row", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `wizard-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };

    const first = await saveOnboardingProgressAction({
      step: "priorities",
      draft: { role: "Precision engineer" },
    });
    expect(first.ok).toBe(true);
    const rows = await holder
      .db!.select()
      .from(onboardingSessions)
      .where(eq(onboardingSessions.workspaceId, seed.workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("in_progress");
    expect(rows[0]?.step).toBe("priorities");
    expect(rows[0]?.draft).toEqual({ role: "Precision engineer" });
    const versionAfterCreate = rows[0]?.version ?? 0;

    const second = await saveOnboardingProgressAction({
      step: "words",
      draft: { role: "Precision engineer", freeform: "words of my own" },
    });
    expect(second.ok).toBe(true);
    const updated = await holder
      .db!.select()
      .from(onboardingSessions)
      .where(eq(onboardingSessions.workspaceId, seed.workspaceId));
    expect(updated).toHaveLength(1);
    expect(updated[0]?.step).toBe("words");
    expect(updated[0]?.draft).toEqual({ role: "Precision engineer", freeform: "words of my own" });
    expect(updated[0]?.version).toBe(versionAfterCreate + 1);
  });

  it("rejects an unknown step and an ill-shaped draft without touching the row", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `wizard-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };

    const badStep = await saveOnboardingProgressAction({ step: "interview" });
    expect(badStep.ok).toBe(false);
    const badDraft = await saveOnboardingProgressAction({
      step: "review",
      draft: { tools: "not-an-array" },
    });
    expect(badDraft.ok).toBe(false);
    const rows = await holder
      .db!.select()
      .from(onboardingSessions)
      .where(eq(onboardingSessions.workspaceId, seed.workspaceId));
    expect(rows).toHaveLength(0);
  });

  it("fails the assist on the same credential gate as the interview, without calling the model or auditing", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `wizard-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };
    generateObject.mockClear();
    vi.stubEnv("GROQ_API_KEY", "");

    const result = await refineOnboardingDraftAction(freeform);
    vi.unstubAllEnvs();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/gemini|model|key/i);
    expect(generateObject).not.toHaveBeenCalled();
    const audits = await holder
      .db!.select({ n: count() })
      .from(auditEvents)
      .where(eq(auditEvents.action, "onboarding.assisted"));
    expect(audits[0]?.n).toBe(0);
  });

  it("composes a draft through the reused brief schema, audits it, and never mints a run", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `wizard-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };
    generateObject.mockClear();
    vi.stubEnv("GROQ_API_KEY", "test-key");

    const result = await refineOnboardingDraftAction(freeform);
    vi.unstubAllEnvs();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft).toEqual({
        agentName: "Pino's Own",
        role: "Precision engineer",
        tools: ["Notion", "Linear"],
        priorities: ["Ship the deslop wave", "Keep onboarding honest"],
      });
    }
    // The schema the action passed IS the response contract, reused verbatim.
    expect(generateObject).toHaveBeenCalledTimes(1);
    const call = generateObject.mock.calls[0]?.[0] as { schema: unknown; system: string; prompt: string };
    expect(call.schema).toBe(onboardingBriefSchema);
    expect(call.system).toMatch(/never invent/i);
    expect(call.prompt).toContain("I build precision tools for one-person teams");
    // One awaited call, not a run: no run row, so no stream, no spend, nothing to retire.
    const runs = await holder
      .db!.select({ n: count() })
      .from(agentRuns)
      .where(eq(agentRuns.workspaceId, seed.workspaceId));
    expect(runs[0]?.n).toBe(0);
    const audits = await holder
      .db!.select({ subjectId: auditEvents.subjectId })
      .from(auditEvents)
      .where(eq(auditEvents.action, "onboarding.assisted"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.subjectId).toBe(seed.workspaceId);
  });

  it("labels an assist failure instead of throwing when the model call fails", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `wizard-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };
    generateObject.mockImplementationOnce(async () => {
      throw new Error("provider 500");
    });
    vi.stubEnv("GROQ_API_KEY", "test-key");

    const result = await refineOnboardingDraftAction(freeform);
    vi.unstubAllEnvs();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("provider 500");
    const audits = await holder
      .db!.select({ n: count() })
      .from(auditEvents)
      .where(eq(auditEvents.action, "onboarding.assisted"));
    expect(audits[0]?.n).toBe(0);
  });

  it("stamps the welcome exactly once", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `wizard-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };
    await holder.db!.insert(onboardingSessions).values({
      workspaceId: seed.workspaceId,
      userId: seed.userId,
      status: "completed",
      role: "Precision engineer",
      tools: ["Notion"],
      priorities: ["Ship"],
      personifiedBrief: "brief",
      step: "review",
      createdBy: seed.userId,
      updatedBy: seed.userId,
    });

    const first = await markOnboardingWelcomedAction();
    expect(first.ok).toBe(true);
    const stamped = await holder
      .db!.select()
      .from(onboardingSessions)
      .where(eq(onboardingSessions.workspaceId, seed.workspaceId));
    expect(stamped[0]?.welcomedAt).not.toBeNull();

    const second = await markOnboardingWelcomedAction();
    expect(second.ok).toBe(true);
    const restamped = await holder
      .db!.select()
      .from(onboardingSessions)
      .where(eq(onboardingSessions.workspaceId, seed.workspaceId));
    expect(restamped[0]?.welcomedAt?.getTime()).toBe(stamped[0]?.welcomedAt?.getTime());
  });
});
