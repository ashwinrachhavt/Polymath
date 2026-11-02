/**
 * The ticket executor: the engine's Executor port over eve runs. One eve run
 * carries one TicketRun. The port's methods — called inside engine commands —
 * enqueue effects only; the durable work happens in the handlers the effects
 * drain calls after commit, so a crash between decision and execution loses
 * nothing (spec §4, the one-writer invariant).
 */
import type { AuthContext } from "@/domains/identity/resolve";
import type { EngineForExecutor, WorkerReport } from "../core/engine";
import { UserError } from "../core/errors";
import { latestRun, runningTicketRun, type Ticket, type TicketRun } from "../core/model";
import type { Repositories } from "../core/ports";
import { Later } from "./errors";
import { admission, spareEligible, type ExecutorConfig } from "./slots";
import { inputMessage, launchObjective } from "./messages";
import { isActiveRunState, type EveForSuperagent, type LiveRun } from "./eve";
import type { Executor } from "../core/ports";

/** The effect queue the executor enqueues into; the effects module owns the drain. */
interface ExecutorEffects {
  enqueue(effect: { kind: "launch" | "delivery"; key: string; payload: Record<string, unknown> }): void;
}

export interface LaunchPayload {
  ticketId: string;
  runId: string;
}

type DeliveryPayload = LaunchPayload;

/**
 * Everything the executor borrows from its host. `repos` is the read side of
 * the domain store (or MemoryRepositories in specs); `engine` is the sole
 * writer behind it. The host owns transaction edges: `flush` persists the
 * domain writes a handler made, and `afterCommit` schedules work that must
 * not run inside one — a cancel of a live session after a stop command.
 */
export interface ExecutorHost {
  workspaceId: string;
  repos: Repositories;
  engine: EngineForExecutor;
  effects: ExecutorEffects;
  eve: EveForSuperagent;
  afterCommit(work: () => Promise<void>): void;
  flush(): Promise<void>;
  auth(): Promise<AuthContext>;
  config: ExecutorConfig;
}

export interface SuperagentExecutor extends Executor {
  /** The launch effect's handler. */
  handleLaunch(payload: LaunchPayload): Promise<void>;
  /** The delivery effect's handler. */
  handleDelivery(payload: DeliveryPayload): Promise<void>;
  /**
   * Host-restart recovery: report every interrupted ticket run oldest-first.
   * A pending launch effect is durable in the queue and needs no recovery.
   */
  recover(): Promise<void>;
}

/**
 * The one effect key per unit: a launch is a TicketRun, a delivery is a
 * ticket — coalescing a burst of messages into one pass (spec §4).
 */
function launchKey(run: Pick<TicketRun, "id">): string {
  return run.id;
}

/**
 * Whether the run's last word was its handoff: a waiting or ready report that
 * the session has since taken no messages after. Stopping such a run would
 * take the conversation out from under a person who is mid-review, so a stop
 * of it cancels nothing — the session keeps for its follow-up. A busy report
 * (messages arrived after it) means the session is working on fresh input:
 * the stop reaches it.
 */
export function handedOff(run: TicketRun): boolean {
  const report = run.report;
  if (!report) return false;
  // Busy means an input reached the session after the report. Nothing delivered
  // yet (the origin rode the objective) also means the report is the last word —
  // the same settle rule the core's `interrupted` applies.
  if (run.deliveredAt !== undefined && run.deliveredAt >= report.at) return false;
  return report.state === "waiting" || report.state === "ready" || report.state === "dropped";
}

/** The workspace's currently executing ticket runs, from the domain state itself. */
function countRunning(host: ExecutorHost): number {
  return host.repos.tickets.active().filter((ticket) => runningTicketRun(ticket) !== undefined).length;
}

/** A benign race only: the ticket ended while this work was in flight. */
function tolerateEndedTicket(run: () => void): void {
  try {
    run();
  } catch (cause) {
    if (cause instanceof UserError && cause.code === "ticketEnded") return;
    throw cause;
  }
}

/** Report a run failed with a capped summary; a ticket that ended meanwhile stays ended. */
function reportFailed(host: ExecutorHost, ticketId: string, summary: string): void {
  tolerateEndedTicket(() =>
    host.engine.report(ticketId, {
      state: "failed",
      summary: summary.length > 300 ? `${summary.slice(0, 300)}…` : summary,
    } satisfies Omit<WorkerReport, "at">),
  );
}

export function createSuperagentExecutor(host: ExecutorHost): SuperagentExecutor {
  const triggerOf = (id: string) => host.repos.triggers.get(id);

  /** The Executor port — enqueue only, no I/O, safe inside any command. */
  const port: Executor = {
    start(ticket, assignment): void {
      host.effects.enqueue({
        kind: "launch",
        key: launchKey(assignment),
        payload: { ticketId: ticket.id, runId: assignment.id },
      });
    },
    deliver(ticket): void {
      host.effects.enqueue({
        kind: "delivery",
        key: ticket.id,
        payload: { ticketId: ticket.id, runId: runningTicketRun(ticket)?.id ?? latestRun(ticket)?.id ?? "" },
      });
    },
    stop(ticket, assignment): void {
      if (handedOff(assignment)) return;
      const { id: ticketId } = ticket;
      const runId = assignment.id;
      // After commit: the cancel must not fail the command that decided it,
      // and the domain store's flush must land first. A lost cancel here is
      // visible — the session's outcome still reports, or recovery collects it.
      host.afterCommit(async () => {
        const live = await host.eve.liveRun({ workspaceId: host.workspaceId, ticketId, runId });
        if (!live) return;
        await host.eve.cancel({ workspaceId: host.workspaceId, auth: await host.auth(), agentRunId: live.agentRunId });
      });
    },
  };

  const handleLaunch = async (payload: LaunchPayload): Promise<void> => {
    const { ticketId, runId } = payload;
    const ticket = host.repos.tickets.get(ticketId);
    const run = ticket?.runs.find((candidate) => candidate.id === runId);
    // Stale effect: the domain moved on — the run was retried or the ticket
    // stopped, and that decision's own stop cancelled the work. Nothing to do.
    if (!ticket || !run || run.state !== "pending") return;

    if (admission(countRunning(host), spareEligible(ticket, triggerOf), host.config.maxRunning) === "defer") {
      throw new Later("worker slots are full; the launch retries when a slot frees");
    }
    const auth = await host.auth();
    // One eve run per TicketRun, for real: the subject query is the idempotence
    // check. An active run means a replayed effect — record the start only. A
    // terminal run means the session ended before the domain learned it started;
    // record that honestly rather than starting a second run over it.
    const existing: LiveRun | undefined = await host.eve.lastRun({ workspaceId: host.workspaceId, ticketId, runId });
    if (existing) {
      if (isActiveRunState(existing.state)) {
        tolerateEndedTicket(() => host.engine.runStarted(ticketId, runId));
        await host.flush();
        return;
      }
      reportFailed(
        host,
        ticketId,
        `The run's session ended before it did any work (session state: ${existing.state}).`,
      );
      await host.flush();
      return;
    }

    try {
      await host.eve.start({
        workspaceId: host.workspaceId,
        auth,
        ticketId,
        runId,
        objective: launchObjective(ticket, triggerOf),
        profileName: host.config.profileName,
        estimateUsd: host.config.estimateUsd,
      });
    } catch (cause) {
      reportFailed(host, ticketId, `Launch failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      await host.flush();
      return;
    }
    tolerateEndedTicket(() => host.engine.runStarted(ticketId, runId));
    await host.flush();
  };

  const handleDelivery = async (payload: DeliveryPayload): Promise<void> => {
    const { ticketId, runId } = payload;
    const ticket = host.repos.tickets.get(ticketId);
    const run = ticket && runningTicketRun(ticket);
    // Stale effect: no running TicketRun on this ticket, or this effect's run
    // was superseded, or nothing is undelivered. The domain's own transitions
    // enqueued a fresh delivery if one is owed.
    if (!ticket || !run || run.id !== runId || !ticket.undelivered.length) return;

    const auth = await host.auth();
    const live = await host.eve.liveRun({ workspaceId: host.workspaceId, ticketId, runId: run.id });
    if (!live) {
      // The session died without the domain knowing. Record a failed delivery
      // so the panel says so and the person's next message retries the run.
      tolerateEndedTicket(() => host.engine.deliveryFailed(ticketId, run.id, "The run's session is no longer active."));
      await host.flush();
      return;
    }

    const wasIdle = live.state === "waiting_input";
    const undelivered = [...ticket.undelivered];
    const delivered: string[] = [];
    let failure: unknown;
    for (const inputId of undelivered) {
      const input = ticket.inputs.find((candidate) => candidate.id === inputId);
      if (!input) continue;
      try {
        await host.eve.signal({
          workspaceId: host.workspaceId,
          auth,
          agentRunId: live.agentRunId,
          text: inputMessage(input, triggerOf),
        });
        delivered.push(inputId);
      } catch (cause) {
        failure = cause;
        break;
      }
    }

    if (delivered.length) {
      tolerateEndedTicket(() => host.engine.inputsDelivered(ticketId, run.id, delivered));
      // A session that was waiting took the messages into a fresh step: mark
      // them read so the stage table shows working, not idle (core engine).
      if (wasIdle && delivered.length === undelivered.length) {
        tolerateEndedTicket(() => host.engine.inputsRead(ticketId, delivered));
      }
      await host.flush();
    }
    if (failure !== undefined) {
      // Delivery stopped partway: the prefix is durable, the rest retries with
      // the effect's backoff — the effect key is the ticket, so a re-pass
      // delivers only what remains undelivered.
      tolerateEndedTicket(() =>
        host.engine.deliveryFailed(
          ticketId,
          run.id,
          `Delivery stopped partway (${delivered.length}/${undelivered.length} delivered): ${
            failure instanceof Error ? failure.message : String(failure)
          }`,
        ),
      );
      await host.flush();
      throw failure;
    }
  };

  const recover = async (): Promise<void> => {
    const interrupted = host.repos.tickets
      .active()
      .map((ticket) => ({ ticket, run: runningTicketRun(ticket) }))
      .filter((item): item is { ticket: Ticket; run: TicketRun } => item.run !== undefined)
      .sort((a, b) => {
        const at = (item: { ticket: Ticket; run: TicketRun }) => item.run.startedAt ?? item.run.createdAt;
        return at(a).localeCompare(at(b));
      });
    for (const { ticket, run } of interrupted) {
      // Look before the domain decides: if it restarts the ticket, the old
      // session must not keep working in parallel with the new run.
      const prior = await host.eve.liveRun({ workspaceId: host.workspaceId, ticketId: ticket.id, runId: run.id });
      host.engine.runInterrupted(ticket.id, run.id);
      const after = host.repos.tickets.get(ticket.id);
      const afterLatest = after && latestRun(after);
      const restarted = !!afterLatest && afterLatest.id !== run.id;
      if (restarted && prior) {
        host.afterCommit(async () => {
          await host.eve.cancel({
            workspaceId: host.workspaceId,
            auth: await host.auth(),
            agentRunId: prior.agentRunId,
          });
        });
      }
      await host.flush();
    }
  };

  return { ...port, handleLaunch, handleDelivery, recover };
}

/**
 * The module's public surface: the port, its handlers, and the slot rules.
 * The seam's types export from eve.ts; the error from errors.ts (the spec
 * imports both there). The effects module's wiring re-exports what it needs
 * when it lands.
 */
export { EXECUTOR_DEFAULTS, admission, parseExecutorConfig, spareEligible, type ExecutorConfig } from "./slots";
