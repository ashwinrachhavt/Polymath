import { describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "./fake";
import {
  runtimeSignal,
  runtimeStartRequest,
  type AgentRuntime,
  type RunIdentity,
  type RuntimeSignal,
  type RuntimeStartRequest,
} from "./contracts";

/*
 * The shared AgentRuntime behavioral suite (RT02). Every adapter - the fake
 * now, Eve when ASH-119 lands it - runs these same tests. A behavior belongs
 * here when orchestration depends on it: dedupe on dispatch keys and signal
 * IDs, three-valued dispatch and reconciliation, terminal immutability,
 * generation fencing.
 *
 * `controls` is the adapter's test handle. For the fake it programs faults;
 * a real adapter's handle maps the same verbs onto its sandbox or a record/
 * replay harness. An adapter that cannot program a behavior must say so in
 * its suite invocation rather than deleting the case.
 */

export type RuntimeTestControls = {
  /** Make the next start's response disappear after the session was created. */
  loseNextStartResponse(): void;
  /** Make the next signal's response disappear after delivery. */
  loseNextSignalResponse(): void;
  /** Drive the session to a phase with optional output (completion before validation). */
  forcePhase(identity: RunIdentity, phase: "completed" | "failed", output?: string): void;
  /** A callback that arrives after cancel; must not resurrect the session. */
  flushLateCallback(effect: () => void): void;
};

export function makeStartRequest(overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest {
  return runtimeStartRequest.parse({
    identity: {
      contractVersion: 1,
      runId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      executionGeneration: 1,
    },
    dispatchKey: `dispatch:${crypto.randomUUID()}`,
    objective: "Research the company and report back.",
    profileRef: { profileId: crypto.randomUUID(), revision: 1 },
    grant: {
      grantId: crypto.randomUUID(),
      profileRevision: 1,
      allowedOperations: ["read", "prepare"],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      delegationDepth: 0,
    },
    reservation: { reservationId: crypto.randomUUID(), currency: "USD", maxUnits: "1.00" },
    limits: { maxRuntimeSeconds: 900, maxToolCalls: 50 },
    ...overrides,
  });
}

export function makeSignal(identity: RunIdentity, kind: RuntimeSignal["kind"] = "user_input"): RuntimeSignal {
  return runtimeSignal.parse({ identity, signalId: crypto.randomUUID(), kind });
}

export function runAgentRuntimeContract(
  name: string,
  make: () => { runtime: AgentRuntime; controls: RuntimeTestControls },
): void {
  describe(`AgentRuntime contract: ${name}`, () => {
    it("accepts a start and dedupes a retried dispatch key", async () => {
      const { runtime } = make();
      const req = makeStartRequest();
      const first = await runtime.start(req);
      expect(first.kind).toBe("accepted");
      const retry = await runtime.start(req);
      expect(retry.kind).toBe("duplicate");
      if (first.kind === "accepted" && retry.kind === "duplicate") {
        expect(retry.runtimeRef).toBe(first.runtimeRef);
      }
    });

    it("a lost start response reconciles to found, never to a second session", async () => {
      const { runtime, controls } = make();
      const req = makeStartRequest();
      controls.loseNextStartResponse();
      const outcome = await runtime.start(req);
      expect(outcome.kind).toBe("unknown");
      const reconciled = await runtime.reconcileStart(req.identity, req.dispatchKey);
      expect(reconciled.kind).toBe("found");
    });

    it("reconciliation of a never-started identity is confirmed-absent", async () => {
      const { runtime } = make();
      const req = makeStartRequest();
      const reconciled = await runtime.reconcileStart(req.identity, req.dispatchKey);
      expect(reconciled.kind).toBe("confirmed-absent");
    });

    it("dedupes a redelivered signal by its durable id", async () => {
      const { runtime } = make();
      const req = makeStartRequest();
      await runtime.start(req);
      const signal = makeSignal(req.identity);
      expect((await runtime.signal(signal)).kind).toBe("delivered");
      expect((await runtime.signal(signal)).kind).toBe("duplicate");
    });

    it("a lost signal response was still delivered once - the retry dedupes", async () => {
      const { runtime, controls } = make();
      const req = makeStartRequest();
      await runtime.start(req);
      const signal = makeSignal(req.identity);
      controls.loseNextSignalResponse();
      expect((await runtime.signal(signal)).kind).toBe("unknown");
      expect((await runtime.signal(signal)).kind).toBe("duplicate");
    });

    it("a signal for an unknown identity fails without effect", async () => {
      const { runtime } = make();
      const req = makeStartRequest();
      await expect(runtime.signal(makeSignal(req.identity))).rejects.toThrow();
    });

    it("cancel is terminal and idempotent", async () => {
      const { runtime } = make();
      const req = makeStartRequest();
      await runtime.start(req);
      expect((await runtime.cancel(req.identity)).kind).toBe("cancelled");
      expect((await runtime.cancel(req.identity)).kind).toBe("already-terminal");
    });

    it("a late callback after cancel never resurrects the session", async () => {
      const { runtime, controls } = make();
      const req = makeStartRequest();
      await runtime.start(req);
      await runtime.cancel(req.identity);
      controls.flushLateCallback(() => controls.forcePhase(req.identity, "completed", "late output"));
      const seen = await runtime.inspect(req.identity);
      expect(seen.kind).toBe("found");
      if (seen.kind === "found") expect(seen.observation.phase).toBe("cancelled");
    });

    it("completion exposes output separately: completed is not validated", async () => {
      const { runtime, controls } = make();
      const req = makeStartRequest();
      await runtime.start(req);
      controls.forcePhase(req.identity, "completed", "unvalidated model text");
      const seen = await runtime.inspect(req.identity);
      expect(seen.kind).toBe("found");
      if (seen.kind === "found") {
        expect(seen.observation.phase).toBe("completed");
        expect(seen.observation.output).toBe("unvalidated model text");
      }
    });

    it("operations fence on the execution generation", async () => {
      const { runtime } = make();
      const gen1 = makeStartRequest();
      await runtime.start(gen1);
      const gen2Identity: RunIdentity = { ...gen1.identity, executionGeneration: 2 };
      // A signal from generation 2 when only generation 1 was admitted: unknown identity.
      await expect(runtime.signal(makeSignal(gen2Identity))).rejects.toThrow();
    });
  });
}

/** The suite the repo runs for its own fake. Adapters import runAgentRuntimeContract with their own controls. */
export function runFakeRuntimeContract(): void {
  runAgentRuntimeContract("FakeAgentRuntime", () => {
    const fake = new FakeAgentRuntime();
    return {
      runtime: fake,
      controls: {
        loseNextStartResponse: () => fake.programFault({ kind: "lose-start-response" }),
        loseNextSignalResponse: () => fake.programFault({ kind: "lose-signal-response" }),
        forcePhase: (identity, phase, output) => fake.forcePhase(identity, phase, output ?? null),
        flushLateCallback: (effect) => {
          fake.scheduleLateCallback(effect);
          fake.flushLateCallbacks();
        },
      },
    };
  });
}
