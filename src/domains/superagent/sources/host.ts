/** The host seams a Source plugin runs against; the store, effects, and cutover wiring implement them. */
import type { OutboundMessage, ReceiveResult, Trigger } from "../core";

/**
 * One event of the chat transcript, reduced to what translation needs. Polymath's durable chat stream is `run_events`
 * (`src/domains/agents`); the reader that produces these joins each event with the identity its run carries — the actor
 * who wrote it and the conversation thread it belongs to — which the event row itself does not hold.
 */
export interface ChatEvent {
  runId: string;
  /** Monotonically increasing per run; the stream cursor `run_events` already enforces. */
  sequence: number;
  type: string;
  data: Record<string, unknown>;
  /** The workspace user the run belongs to; the chat Source's actor id for the event. */
  actorId: string;
  /** The conversation thread of the run, when it has one; an unthreaded run is its own conversation. */
  threadId?: string;
  /** When the event was recorded, as the Source's timestamp for the Trigger. */
  at: string;
}

/** Source-scoped read positions, such as a chat read cursor; setting `undefined` removes an entry. */
export interface SourceState {
  get(key: string): string | undefined;
  set(key: string, value: string | undefined): void;
}

/**
 * Where the chat channel's writes go. The effects wiring implements it over the run's durable event stream: the reply
 * must reach live tabs through the existing ChatFrame proxy and survive a reload. No other transport exists or is added.
 */
export interface ChatStreamSink {
  /**
   * @returns `'sent'` once written durably, `'gone'` when the conversation can never receive it — never both.
   * @throws when delivery failed but may succeed on a later retry; the Outbox doubles its retry from 5s to 300s.
   */
  send(message: OutboundMessage): Promise<"sent" | "gone">;
}

/**
 * What one Source kind reads and tells the host: its configuration while enabled, trigger ingestion, its read
 * positions, the chat transcript reader, and the chat stream its replies go out on. Adapted from the prototype's
 * `SourceContext`; the polling loop, KV registry, thread descriptions, and health board it also carried belong to the
 * effects and store wiring, which this wave keeps behind these seams.
 */
export interface SourceContext {
  /** The stored configuration of a Source kind while it is enabled; `undefined` while disabled or unknown. */
  config(kind: string): Record<string, unknown> | undefined;
  /**
   * Ingests a trigger into the Engine and runs the evaluation clock after it; everything a Source sees goes through
   * here, triggers the scope filters included, so the panel can explain what was dropped and why.
   */
  receive(trigger: Trigger): ReceiveResult;
  /** The Source's read positions. */
  state: SourceState;
  /** The chat transcript, oldest first; `after` reads the events a sequence follows. */
  events: { latestSequence(): number | undefined; after(sequence: number): ChatEvent[] };
  /** The chat stream replies go out on. */
  chatStream: ChatStreamSink;
}
