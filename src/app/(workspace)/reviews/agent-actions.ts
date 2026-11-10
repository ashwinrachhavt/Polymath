"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  createEngine,
  createPolicy,
  key,
  policyVersion,
  type Assessor,
  type EngineForPeople,
  type Executor,
  type PolicyConfig,
  type PolicyRule,
} from "@/domains/superagent/core";
import { SourceRegistry } from "@/domains/superagent/sources";
import { createSuperagentStore, getPolicy, savePolicy, storedPolicyConfig } from "@/domains/superagent/store";
import { evictSuperagentHost } from "@/domains/superagent/wiring";
import { db } from "@/lib/db";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/**
 * The supervision panel's people commands. Reads go through the store and
 * the pure view; writes go through the Engine — the sole writer of domain
 * state — and flush through the store's compare-and-set.
 *
 * The assessor and executor ports are not wired in this wave (they arrive
 * with the cutover); the stubs fail loudly rather than pretending. The
 * policy port is real: it is built from the stored policy document, so a
 * `revalidate` can never answer from defaults.
 */

type ActionResult = { ok: true } | { ok: false; error: string };

const ruleInputSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(120),
  instruction: z.string().max(4000),
  enabled: z.boolean(),
});

const savePolicyInputSchema = z
  .object({
    paused: z.boolean(),
    acceptMode: z.enum(["off", "observe", "auto"]),
    rules: z.array(ruleInputSchema).max(50),
  })
  .strict();

export type SavePolicyInput = z.infer<typeof savePolicyInputSchema>;

/** A person's engine: the people commands over the workspace's store. */
async function peopleEngine(workspaceId: string): Promise<{ engine: EngineForPeople; flush: () => Promise<void> }> {
  const store = createSuperagentStore(db, workspaceId);
  await store.hydrate();
  const config = storedPolicyConfig(await getPolicy(db, workspaceId));
  const scope = new SourceRegistry(() => undefined).scope();
  const notWired = (what: string): never => {
    throw new Error(`${what} is not wired until the cutover wave.`);
  };
  const assessor: Assessor = { request: () => notWired("The assessor") };
  const executor: Executor = {
    start: () => notWired("The executor"),
    deliver: () => notWired("The executor"),
    stop: () => notWired("The executor"),
  };
  const engine = createEngine({
    repo: store.repositories,
    outbox: store.outbox,
    policy: () => createPolicy(config, scope),
    scope,
    assessor,
    executor,
  });
  return { engine, flush: store.flush };
}

export async function savePolicyAction(input: SavePolicyInput): Promise<ActionResult> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const parsed = savePolicyInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "The policy could not be read. Check the fields and try again." };
  }
  try {
    const stored = await getPolicy(db, auth.workspaceId);
    const previous = storedPolicyConfig(stored);
    const rules: PolicyRule[] = parsed.data.rules.map((rule, position) => ({
      // An edited rule keeps its id; only a new rule mints one.
      id: rule.id ?? key("rule", auth.workspaceId, rule.name, rule.instruction, String(Date.now()), String(position)),
      name: rule.name,
      instruction: rule.instruction,
      enabled: rule.enabled,
      position,
    }));
    const config: PolicyConfig = {
      paused: parsed.data.paused,
      mode: parsed.data.acceptMode,
      rules,
      sources: previous.sources,
      evalTimeoutMs: previous.evalTimeoutMs,
    };
    await savePolicy(
      db,
      auth.workspaceId,
      {
        version: policyVersion(config),
        paused: config.paused,
        acceptMode: config.mode,
        evalTimeoutMs: config.evalTimeoutMs,
        sources: stored?.policy.sources ?? {},
      },
      rules.map((rule, position) => ({
        id: rule.id,
        name: rule.name,
        instruction: rule.instruction,
        enabled: rule.enabled,
        position,
      })),
    );
    revalidatePath("/supervision");
    // This process's composition still holds the policy the gate just
    // replaced; drop it so the next intake rebuilds from the saved
    // document. Other processes (the worker) refresh by version in the
    // sweep (evictStaleSuperagentHost).
    evictSuperagentHost(auth.workspaceId);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && error.message === "Forbidden"
          ? "Only workspace members may edit the policy."
          : "The policy could not be saved.",
    };
  }
}

export async function dismissDecisionAction(decisionId: string): Promise<ActionResult> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const { engine, flush } = await peopleEngine(auth.workspaceId);
    engine.dismiss(decisionId);
    await flush();
    revalidatePath("/supervision");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The decision could not be dismissed.",
    };
  }
}
