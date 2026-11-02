/**
 * The Policy port's pure implementation: the gate that decides who may originate work, the accept
 * modes for inferred candidates, the version hash, and mandate revalidation. Ported from the
 * prototype's `src/policy.ts`; settings schemas and panel wiring stay with the host's settings layer,
 * which validates external data and hands a `PolicyConfig` here.
 */
import { key } from "../ids";
import type { AcceptMode, AdmissionCell, ActorRef, Mandate, Ticket, Trigger, WorkThread } from "../model";
import type { GateResult, Policy, SourceScope } from "../ports";
import { ADMISSION_DEFAULTS, type Admission, type AdmissionRow } from "./admission";

/** A rule describing one kind of proactive work; a matching rule's instruction reaches the ticket's worker. */
export interface PolicyRule {
  id: string;
  name: string;
  enabled: boolean;
  instruction: string;
}

/** A sender or bot listed on a Source: matched case-insensitively by id, so lists hold the display name. */
interface AllowedActor {
  id: string;
  name?: string;
}

/** One Source's part of the Policy: its allowed senders, its bots, and its admission table by receiving scope. */
export interface SourcePolicy {
  allowed: AllowedActor[];
  /** Bots whose messages may become inferred candidates at most; never explicit requests or stops. */
  bots: AllowedActor[];
  admission: Record<string, AdmissionRow>;
}

/**
 * Everything work authorization depends on. The version hash covers the rules, the accept mode, and
 * the source parts — and nothing else: pause state and the eval timeout change no mandate's meaning.
 */
export interface PolicyConfig {
  paused: boolean;
  /** Whether inferred candidates are accepted (`auto`), assessed and recorded as would-accept (`observe`), or not admitted (`off`). */
  mode: AcceptMode;
  rules: PolicyRule[];
  sources: Record<string, SourcePolicy>;
  /** How long an assessor may hold a candidate before its eval is recorded unavailable. */
  evalTimeoutMs: number;
}

/** The cold-start config: explicit requests from listed senders work; nothing proactive is enabled yet (docs/002: start in observe). */
export const defaultPolicyConfig = (): PolicyConfig => ({
  paused: false,
  mode: "observe",
  rules: [],
  sources: {},
  evalTimeoutMs: 120_000,
});

/** Case-insensitive sender match: lists hold the name the Source displays, triggers carry the id it saw. */
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `actor` in the Source's allowed list, which decides who may originate work on that Source. */
const allowedSender = (config: PolicyConfig, actor: ActorRef): AllowedActor | undefined =>
  config.sources[actor.source]?.allowed.find((entry) => sameName(entry.id, actor.id));

/** `actor` in the Source's bot list, whose messages are admitted as inferred candidates at most. */
const listedBot = (config: PolicyConfig, actor: ActorRef): AllowedActor | undefined =>
  config.sources[actor.source]?.bots.find((entry) => sameName(entry.id, actor.id));

const senderName = (entry: AllowedActor): string => entry.name || entry.id;

/** Literal gate-reason codes (`reasons.ts`: gates may emit their own); the panel translates them. */
const GATE_REASONS = {
  /** A non-human sender that is no listed bot and has an id. */
  notHuman: "not_human",
  /** The receiving scope's cell, or the accept mode, admits nothing here. */
  admissionIgnored: "admission_ignored",
  /** The sender is not on the Source's allowed list. */
  notAMember: "not_a_member",
  /** The message does not address the agent where the Source listens to mentions only. */
  noMention: "no_mention",
} as const;

/**
 * Stable JSON: object keys sorted, undefined dropped, so equal configs hash equally however their keys
 * are ordered. Mirrors the agents domain's `canonicalJson`; kept local so the core stays dependency-free.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, item]) => `${JSON.stringify(k)}:${canonicalJson(item)}`).join(",")}}`;
};

/** Revision of the version scheme itself; bump it when the hashed payload's shape changes, invalidating every stored version at once. */
const POLICY_REVISION = "mandate-v3";

/** Hash over the rules, the accept mode, and each Source's part (docs/002 §Policy version). */
export const policyVersion = (config: PolicyConfig): string =>
  key(POLICY_REVISION, canonicalJson({ rules: config.rules, mode: config.mode, sources: config.sources }));

const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 };

/** Whether a thread has tickets of its own: any subscription that is not a context-only follow. */
const participating = (thread: WorkThread, tickets: readonly Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map((ticket) => ticket.id)].some((id) => !thread.context?.includes(id));

/** The cell a person's (listed, addressing) combination reads: a listed sender who addresses the agent uses no cell. */
const admissionOf = (
  config: PolicyConfig,
  source: string | undefined,
  row: string | undefined,
  cell: AdmissionCell,
): Admission =>
  (row === undefined ? undefined : config.sources[source ?? ""]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell];

/** Build the active Policy over a SourceScope: it gates incoming Triggers, revalidates Mandates, and decides inferred admission. */
export function createPolicy(config: PolicyConfig, scope: SourceScope): Policy {
  const mode = config.mode;
  const listened = (source: string, meta: Record<string, unknown>) => scope.scope({ source, meta });

  /** Non-human triggers: listed bots (inferred candidates at most) and senderless system events; any other bot is rejected. */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(config, trigger.actor) : undefined;
    if (trigger.actor.id && !bot) return { admissible: false, reason: GATE_REASONS.notHuman };
    const machineScope = listened(trigger.source, trigger.meta);
    if (!machineScope.listened || !(trigger.addressed || machineScope.observed))
      return { admissible: false, reason: GATE_REASONS.notHuman };
    const recorded = {
      source: trigger.source,
      scope: trigger.meta,
      ...(machineScope.row === undefined ? {} : { row: machineScope.row }),
    };
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {};
    if (bot) {
      if (mode === "off") return { admissible: false, reason: GATE_REASONS.admissionIgnored };
      return {
        admissible: true,
        strength: "inferred",
        basis: { ...recorded, via: "bot" as const, sender: senderName(bot), ...addressed, observation: { mode } },
      };
    }
    // A senderless event (CI) has no list: its row offers only the unlisted-unaddressed cell.
    const cell = "unlistedUnaddressed" as const;
    if (admissionOf(config, trigger.source, machineScope.row, cell) !== "inferred" || mode === "off")
      return { admissible: false, reason: GATE_REASONS.admissionIgnored };
    return {
      admissible: true,
      strength: "inferred",
      basis: { ...recorded, via: "admission" as const, cell, observation: { mode } },
    };
  };

  return {
    version: policyVersion(config),
    paused: config.paused,
    evalTimeoutMs: config.evalTimeoutMs,
    gate(trigger, thread, tickets) {
      if (!trigger.human) return machineGate(trigger);
      const allowed = allowedSender(config, trigger.actor);
      const listenedScope = listened(trigger.source, trigger.meta);
      const row = listenedScope.listened ? listenedScope.row : undefined;
      const recorded = {
        source: trigger.source,
        scope: trigger.meta,
        ...(row === undefined ? {} : { row }),
        ...(allowed ? { sender: senderName(allowed) } : {}),
      };
      // A listed sender who addresses the agent makes an explicit request, whatever the table says (docs/002 §Strength).
      if (allowed && trigger.addressed)
        return {
          admissible: true,
          strength: "explicit",
          basis: { ...recorded, via: "addressed" as const, addressed: trigger.addressed },
        };
      // The listed-and-addressed case returned above, so exactly three cells remain.
      const cell: AdmissionCell = trigger.addressed
        ? "unlistedAddressed"
        : allowed
          ? "listedUnaddressed"
          : "unlistedUnaddressed";
      // Unaddressed messages read the table only where the Source observes every message in the scope.
      const receivable = !!trigger.addressed || (listenedScope.listened && listenedScope.observed);
      const admission = receivable ? admissionOf(config, trigger.source, row, cell) : "ignore";
      const basis = {
        ...recorded,
        via: "admission" as const,
        cell,
        ...(trigger.addressed ? { addressed: trigger.addressed } : {}),
      };
      // An explicit cell is checked before thread follow-ups, so a thread's tickets never weaken an explicit request.
      if (admission === "explicit") return { admissible: true, strength: "explicit", basis };
      // A direct-message thread belongs to one sender (no follow-up for others), and inferred follow-ups need an accept mode other than off.
      if (
        !(trigger.addressed === "direct" && !allowed) &&
        (allowed || mode !== "off") &&
        participating(thread, tickets)
      )
        return {
          admissible: true,
          strength: allowed ? "explicit" : "inferred",
          basis: { ...recorded, via: "followup" as const },
        };
      if (admission === "inferred" && mode !== "off")
        return { admissible: true, strength: "inferred", basis: { ...basis, observation: { mode } } };
      return {
        admissible: false,
        reason: !allowed
          ? GATE_REASONS.notAMember
          : receivable && admission === "ignore"
            ? GATE_REASONS.admissionIgnored
            : GATE_REASONS.noMention,
      };
    },
    admitsInferred: (rules) =>
      mode === "auto" &&
      rules.length > 0 &&
      rules.every((id) => config.rules.some((rule) => rule.enabled && rule.id === id)),
    revalidate(mandate: Mandate): boolean {
      // Revalidation rules follow docs/002 (§Revalidation before resume).
      const { basis } = mandate;
      const current = basis.source && basis.scope ? listened(basis.source, basis.scope) : undefined;
      if (current && !current.listened) return false;
      const rulesOn = (rules: readonly string[] | undefined): boolean =>
        (rules ?? []).every((id) => config.rules.some((rule) => rule.enabled && rule.id === id));
      // An explicit follow-up holds; an inferred one needs auto mode and its matched rules still enabled.
      if (basis.via === "followup") return mandate.strength === "explicit" || (mode === "auto" && rulesOn(basis.rules));
      // A bot's candidate holds only while the bot remains on its Source's bot list.
      if (basis.via === "bot" && !listedBot(config, mandate.actor)) return false;
      if (basis.via === "admission") {
        const listed = !!allowedSender(config, mandate.actor);
        // A listed sender who addresses the agent is always explicit and reads no cell.
        if (basis.cell === "unlistedAddressed" && listed) return true;
        // A sender added to the allowed list since acceptance moved to the listed cell; the observation checks below still apply.
        const cellNow: AdmissionCell =
          basis.cell === "unlistedUnaddressed" && listed ? "listedUnaddressed" : basis.cell;
        if (cellNow === "listedUnaddressed" && !listed) return false;
        const admission = admissionOf(
          config,
          basis.source,
          current && current.listened ? current.row : undefined,
          cellNow,
        );
        // The cell must still grant at least the strength the mandate was accepted under.
        if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false;
        if (mandate.strength === "explicit") return true;
      } else if (basis.via !== "bot" && !allowedSender(config, mandate.actor)) {
        return false;
      }
      // Observed (inferred) mandates hold only while auto mode is active and all matched rules remain enabled.
      if ((basis.via === "admission" || basis.via === "listed" || basis.via === "bot") && basis.observation)
        return mode === "auto" && rulesOn(basis.rules);
      return true;
    },
  };
}
