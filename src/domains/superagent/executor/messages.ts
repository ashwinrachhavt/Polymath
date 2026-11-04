/**
 * What the executor says to a run's session: one pure formatter per input
 * shape, so the worker's context is bounded and testable. Caps keep a single
 * message from carrying an unbounded prompt into eve — the same discipline the
 * assessor's bounded context applies to judgments (spec §4).
 */
import type { TicketInput, Ticket, Trigger } from "../core/model";

const TRIGGER_TEXT_CAP = 4000;
const NOTE_TEXT_CAP = 2000;
const TITLE_CAP = 200;
const SCOPE_CAP = 2000;

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** A trigger's audit card: who said what, where, and when. */
export function triggerCard(trigger: Trigger): string {
  const who = trigger.human ? "A person" : "An automated sender";
  const addressed = trigger.addressed ? ` (${trigger.addressed})` : "";
  return `${who} wrote on ${trigger.source}${addressed} at ${trigger.at}:\n${cap(trigger.text, TRIGGER_TEXT_CAP)}`;
}

/** The policy-changed input's description: what the new rules change for this ticket. */
function policyChangeText(input: Extract<TicketInput, { kind: "policy-changed" }>): string {
  const parts: string[] = [];
  for (const rule of input.effect?.rules ?? []) {
    if (rule.change === "disabled") parts.push(`rule "${rule.name}" no longer applies`);
    else parts.push(`rule "${rule.name}" changed: ${rule.instruction ?? "its instruction changed"}`);
  }
  if (input.effect?.proactive === false) parts.push("proactive work is no longer accepted");
  if (input.effect?.requesterAllowed === false) {
    parts.push(`the requester ${input.effect.requester?.id ?? "on this ticket"} may no longer start work here`);
  }
  return `The policy changed (${input.from} → ${input.to}).${parts.length ? ` ${parts.join("; ")}.` : ""}`;
}

/**
 * The session-side text of an input. Each shape says what it is before what it
 * says: a worker's model should never mistake an automated notice for a
 * person's instruction. The `triggerOf` lookup resolves a trigger input's
 * stored audit trail; a trigger evicted from storage degrades to a reference.
 */
export function inputMessage(input: TicketInput, triggerOf: (id: string) => Trigger | undefined): string {
  switch (input.kind) {
    case "trigger": {
      const trigger = triggerOf(input.triggerId);
      const body = trigger ? triggerCard(trigger) : `Message ${input.triggerId} (its text is no longer stored).`;
      return input.note ? `${body}\n\nNote: ${cap(input.note, NOTE_TEXT_CAP)}` : body;
    }
    case "text":
      return cap(input.text, TRIGGER_TEXT_CAP);
    case "note":
      return `Context note: ${cap(input.text, NOTE_TEXT_CAP)}`;
    case "policy-changed":
      return policyChangeText(input);
    case "reopen":
      return `A policy decision reopened this ticket; continue from where it stopped.`;
    case "resumed": {
      const trigger = triggerOf(input.triggerId);
      const body = trigger ? triggerCard(trigger) : "(the resuming message's text is no longer stored)";
      return `A person's message resumed this ticket:\n${body}`;
    }
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}

/** The routing lane's instruction line, from the Trigger's meta when Jev classified it. */
const LANE_HINTS: Record<string, string> = {
  answer:
    "Routing lane: answer — answer from what is already known; call a tool only when the answer needs evidence you do not have.",
  research: "Routing lane: research — gather evidence first, then answer with citations.",
  draft: "Routing lane: draft — produce the artifact or proposal text, then say where it waits.",
  operate: "Routing lane: operate — take the local steps, then report exactly what changed.",
};

function routingLine(trigger: Trigger | undefined): string | undefined {
  const lane = trigger?.meta.lane;
  return typeof lane === "string" ? LANE_HINTS[lane] : undefined;
}

/** The first thing a run's session reads: the ticket's scope, and the request that started it. */
export function launchObjective(ticket: Ticket, triggerOf: (id: string) => Trigger | undefined): string {
  const origin = triggerOf(ticket.origin.triggerId);
  const originCard = origin
    ? triggerCard(origin)
    : `(the request that started this ticket is no longer stored: trigger ${ticket.origin.triggerId})`;
  const routing = routingLine(origin);
  return [
    `Ticket id: ${ticket.id}`,
    `Ticket: ${cap(ticket.title, TITLE_CAP)}`,
    `Scope of your mandate: ${cap(ticket.mandate.scope, SCOPE_CAP)}`,
    ...(routing ? [routing] : []),
    `The request that started this ticket:\n${originCard}`,
    `Further messages that arrive on this ticket reach you here as they come. Report progress as you go.`,
  ].join("\n\n");
}
