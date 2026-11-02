/** SourceKind plugin contract: configuration schema, form fields, receiving scope, channel adapter, and policy integration. */
import type { z } from "zod";
import type { OutboundMessage, ScopeResult, Trigger } from "../core";
import type { SourceContext } from "./host";

/** Configuration field specification; the settings panel renders these without per-kind code. */
type FieldSpec =
  | { key: string; label: string; hint?: string; type: "switch" }
  | { key: string; label: string; hint?: string; type: "select"; options: { value: string; label: string }[] }
  | { key: string; label: string; hint?: string; type: "number"; min?: number; max?: number }
  | { key: string; label: string; hint?: string; type: "text"; pattern?: string; optional?: boolean }
  | {
      key: string;
      label: string;
      hint?: string;
      type: "rows";
      columns: (
        | { key: string; label: string; type: "text"; pattern?: string; optional?: boolean }
        | {
            key: string;
            label: string;
            type: "select";
            options: { value: string; label: string }[];
          }
      )[];
    };

/** One admission-table row a kind declares for its receiving scopes; the cells name what each row admits. */
interface AdmissionRowView {
  id: string;
  label: string;
  note: string;
  cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean };
}

/** The Source's part of the Policy: who may originate work there, and what its receiving scopes admit. */
interface SourcePolicyPart<P extends Record<string, unknown> = Record<string, unknown>> {
  /** Validates the Source's part of the Policy, including `allowed` (senders who may originate work). */
  schema: z.ZodType<P>;
  /** Form fields of the policy part; the first is `allowed`. */
  fields: FieldSpec[];
  /** Describes what the Source marks as addressed to the agent, which an allowed sender's explicit request requires. */
  explicit: string;
  /** Receiving scopes of the Policy's admission table under `config` (matching `scope().row`); kinds without `rows` use the defaults. */
  rows?(config: Record<string, unknown>): AdmissionRowView[];
}

/** Outbound messaging adapter for a source kind's conversations. */
interface SourceChannel<C> {
  /** Whether a reply may still go to `address`; without it, every address may receive replies. */
  allowed?(address: Record<string, string>, config: C): boolean;
  /**
   * Sends a message idempotently by its id; the Outbox retries after a throw and never after a result.
   * @returns `'sent'` once delivered, `'gone'` when the conversation can never receive it — never both.
   * @throws when delivery failed but may succeed on a later retry.
   */
  send(host: SourceContext, message: OutboundMessage): Promise<"sent" | "gone">;
  /** The URL and label the panel shows for `address`; `url` is empty when the kind cannot link it. */
  link(address: Record<string, string>): { url: string; label: string };
}

/** One normalized message of a conversation, as assessments read it; `bot` marks a sender whose message never authorizes work alone. */
interface ContextMessage {
  id: string;
  from: string;
  at: string;
  text: string;
  bot?: true;
  deleted?: true;
  url?: string;
}
/** Which slice of a conversation a read returns. */
type ContextPartName = "thread" | "root" | "parent";
interface ContextPart {
  messages: ContextMessage[];
  /** Cursor of the next page; omitted on the last page. */
  next?: string;
  /** The content shown to the assessing session, beyond the message list. */
  body: Record<string, unknown>;
}

/** Bounded thread context reader assessments use to inspect the conversation around a trigger. */
interface ThreadContext<C> {
  /** The id of the Trigger's own message among the messages of its conversation. */
  messageId(trigger: Trigger): string;
  /** Reads a page of the conversation (`thread`, first page when `cursor` is omitted), its root, or the replied-to message. */
  read(
    host: SourceContext,
    trigger: Trigger,
    part: ContextPartName,
    cursor: string | undefined,
    config: C,
  ): Promise<ContextPart>;
}

/**
 * Pluggable source kind descriptor. Sources translate a host's events into Triggers, decide what they receive in `scope`
 * (from `meta` alone, so a recorded Mandate's revalidation reads it back), and expose the channel their replies go out on.
 *
 * Ported from the dsh-superagent-prototype `SourceKind`, adapted to Polymath: the UI is English-only, the host is the
 * {@link SourceContext} of `host.ts`, and `environment` is omitted in wave 1 because Polymath has no prepare hooks
 * (spec §4). A kind without `threadContext` gives assessments no conversation context; the Trigger's own text stays readable.
 */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable id; it names the kind's settings block, prefixes Trigger source values, and keys registrations. */
  kind: string;
  title: string;
  description: string;
  /** Validates stored and submitted configuration and fills defaults. Make defaults receive nothing. */
  schema: z.ZodType<C>;
  fields: FieldSpec[];
  /** Health entry names owned by this kind; no other kind or core loop may report them. */
  health: string[];
  /** Receiving rule for a trigger (or a recorded Mandate basis) of this kind; kinds without `scope` listen to everything they produce and observe none of it. */
  scope?(input: { source: string; meta: Record<string, unknown> }, config: C): ScopeResult;
  /** Outbound reply adapter; kinds without `channel` produce no replies. */
  channel?: SourceChannel<C>;
  /** Bounded context reader for assessments. */
  threadContext?: ThreadContext<C>;
  /** Maps a search query to candidate WorkThread keys and Trigger search terms, for Source-specific references. */
  find?(query: string): { threads: string[]; terms: string[] };
  /** Returns the id of the Trigger whose message this Trigger replies to, when derivable without a read. */
  repliesTo?(trigger: Trigger): string | undefined;
  /** The Source's part of the Policy. */
  policy?: SourcePolicyPart;
}
