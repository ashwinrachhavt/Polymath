import { randomUUID } from "node:crypto";
import type {
  AgentRuntime,
  CancelOutcome,
  RunIdentity,
  RuntimeObservation,
  RuntimePhase,
  RuntimeSignal,
  RuntimeStartRequest,
  SignalOutcome,
  StartOutcome,
  StartReconciliation,
} from "./contracts";
import { runIdentity } from "./contracts";

/*
 * The programmable fake runtime (RT02): an in-memory AgentRuntime that honest-
 * ly models the failures a real one has - lost responses, duplicate delivery,
 * late callbacks, obsolete generations, provider uncertainty - so orchestration
 * tests run against behavior, not hope. It is also the reference implementa-
 * tion for the shared contract suite: a real adapter must pass the same suite.
 *
 * Honesty rules the fake keeps (an adapter must too):
 *  - `unknown` outcomes leave the session state untouched from the caller's
 *    point of view: the session may or may not exist; reconcileStart answers.
 *  - confirmed-absent is only ever returned for an identity the fake can
 *    affirm it has never seen (it is authoritative over its own store).
 *  - a completed session still holds its output separately: phase says
 *    "completed", output says what it produced; validation is the caller's.
 */

type Session = {
  identity: RunIdentity;
  dispatchKey: string;
  runtimeRef: string;
  phase: RuntimePhase;
  output: string | null;
  signals: RuntimeSignal[];
  deliveredSignalIds: Set<string>;
};

type Fault =
  | { kind: "lose-start-response" }
  | { kind: "lose-signal-response" }
  | { kind: "provider-uncertainty" };

const TERMINAL: RuntimePhase[] = ["completed", "failed", "cancelled"];
const keyOf = (id: RunIdentity) => `${id.runId}:${id.executionGeneration}`;

export class FakeAgentRuntime implements AgentRuntime {
  private sessions = new Map<string, Session>();
  private dispatchIndex = new Map<string, string>();
  private faults: Fault[] = [];
  /** Late callbacks the test schedules; flushed explicitly. */
  private pendingCallbacks: (() => void)[] = [];
  /** When set, inspect answers unknown for every session (provider fog). */
  private fog = false;

  // ---- programming surface (tests) ----

  programFault(fault: Fault): void {
    this.faults.push(fault);
  }

  /** A callback arriving after its session ended: must never resurrect it. */
  scheduleLateCallback(effect: () => void): void {
    this.pendingCallbacks.push(effect);
  }

  flushLateCallbacks(): void {
    const pending = this.pendingCallbacks.splice(0);
    for (const effect of pending) effect();
  }

  setProviderFog(on: boolean): void {
    this.fog = on;
  }

  /** Test-only: drive a session to a phase, e.g. completion before validation. */
  forcePhase(identity: RunIdentity, phase: RuntimePhase, output: string | null = null): void {
    const session = this.sessions.get(keyOf(identity));
    if (!session) throw new Error("no such session");
    if (TERMINAL.includes(session.phase)) return; // terminal is immutable
    session.phase = phase;
    session.output = output;
  }

  signalCount(identity: RunIdentity): number {
    return this.sessions.get(keyOf(identity))?.deliveredSignalIds.size ?? 0;
  }

  // ---- the port ----

  async start(request: RuntimeStartRequest): Promise<StartOutcome> {
    const key = keyOf(request.identity);
    const byDispatch = this.dispatchIndex.get(`${request.identity.workspaceId}:${request.dispatchKey}`);
    if (byDispatch) {
      const existing = this.sessions.get(byDispatch);
      if (existing) return { kind: "duplicate", runtimeRef: existing.runtimeRef };
    }
    const session: Session = {
      identity: request.identity,
      dispatchKey: request.dispatchKey,
      runtimeRef: `fake_${randomUUID()}`,
      phase: "starting",
      output: null,
      signals: [],
      deliveredSignalIds: new Set(),
    };
    this.sessions.set(key, session);
    this.dispatchIndex.set(`${request.identity.workspaceId}:${request.dispatchKey}`, key);
    session.phase = "running";
    const fault = this.faults.shift();
    if (fault?.kind === "lose-start-response" || fault?.kind === "provider-uncertainty") {
      // The session exists; the caller never learns it from this response.
      return { kind: "unknown", detail: fault.kind === "provider-uncertainty" ? "provider returned an ambiguous status" : "response lost" };
    }
    return { kind: "accepted", runtimeRef: session.runtimeRef, acceptedAt: new Date().toISOString() };
  }

  async signal(signal: RuntimeSignal): Promise<SignalOutcome> {
    const session = this.sessions.get(keyOf(signal.identity));
    if (!session) throw new Error("runtime signal for an unknown run identity");
    if (session.deliveredSignalIds.has(signal.signalId)) return { kind: "duplicate" };
    if (TERMINAL.includes(session.phase)) throw new Error("runtime signal for a terminal session");
    const fault = this.faults.shift();
    if (fault?.kind === "lose-signal-response") {
      // Delivered but unacknowledged: a retry must dedupe, not double-apply.
      session.deliveredSignalIds.add(signal.signalId);
      session.signals.push(signal);
      return { kind: "unknown", detail: "response lost" };
    }
    session.deliveredSignalIds.add(signal.signalId);
    session.signals.push(signal);
    if (signal.kind === "cancellation") session.phase = "cancelled";
    return { kind: "delivered" };
  }

  async inspect(identity: RunIdentity): Promise<StartReconciliation> {
    if (this.fog) return { kind: "unknown", detail: "provider cannot confirm right now" };
    const session = this.sessions.get(keyOf(identity));
    if (!session) {
      // The fake is authoritative over its own store, so absence is confirmable.
      return { kind: "confirmed-absent" };
    }
    return { kind: "found", observation: this.observe(session) };
  }

  async reconcileStart(identity: RunIdentity, dispatchKey: string): Promise<StartReconciliation> {
    if (this.fog) return { kind: "unknown", detail: "provider cannot confirm right now" };
    const byDispatch = this.dispatchIndex.get(`${identity.workspaceId}:${dispatchKey}`);
    if (!byDispatch) return { kind: "confirmed-absent" };
    const session = this.sessions.get(byDispatch);
    if (!session || keyOf(session.identity) !== keyOf(identity)) return { kind: "confirmed-absent" };
    return { kind: "found", observation: this.observe(session) };
  }

  async cancel(identity: RunIdentity): Promise<CancelOutcome> {
    const session = this.sessions.get(keyOf(identity));
    if (!session) throw new Error("cancel for an unknown run identity");
    if (TERMINAL.includes(session.phase)) return { kind: "already-terminal" };
    session.phase = "cancelled";
    return { kind: "cancelled" };
  }

  private observe(session: Session): RuntimeObservation {
    return {
      identity: runIdentity.parse(session.identity),
      runtimeRef: session.runtimeRef,
      phase: session.phase,
      output: session.output,
      detail: null,
      observedAt: new Date().toISOString(),
    };
  }
}
