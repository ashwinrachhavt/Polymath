/** The chat Source: the Polymath chat surface as superagent intake — translation, scope, read position, and channel. */
import { z } from "zod";
import type { ChatFrame } from "@/domains/agents/stream-contract";
import { key, threadKey, type OutboundMessage, type Trigger } from "../core";
import type { ChatEvent, SourceContext } from "./host";
import type { SourceKind } from "./kind";

/** The Source id the chat plugin registers under; it prefixes every chat Trigger's `source` and WorkThread keys. */
export const CHAT_SOURCE_KIND = "chat";
/** The admission-table row the chat scope names; the Policy's `rows` for the chat kind must match it. */
export const CHAT_SCOPE_ROW = "chat";
/** The chat read position, advanced only after every covered trigger was stored; the one state key the plugin owns. */
export const CHAT_READ_CURSOR = "chat:read-cursor";

/**
 * The chat Source's configuration. A person's message in the chat surface is always a direct message to the agent, so
 * the listen mode does not gate explicit requests: it decides whether the Source also *observes* the messages that do
 * not address the agent (a bot's), which an admission row may turn into inferred candidates. The default is the
 * conservative one: nothing observed.
 */
const ChatConfigSchema = z
  .object({
    listen: z.enum(["mentions", "all"]).default("mentions"),
  })
  .strict();
export type ChatSourceConfig = z.infer<typeof ChatConfigSchema>;

/**
 * The Trigger of one chat message. The agent's own words produce none: an assistant, system, or tool event is never a
 * person's utterance, and neither is a non-message event such as the run's seeded objective. The id is derived from the
 * message's stream identity `(runId, sequence)` through the domain's content hash, so re-reading a message always
 * yields the same trigger id and `Engine.receive` makes the second one a `duplicate`.
 */
export function chatTrigger(event: ChatEvent): Trigger | undefined {
  if (event.type !== "message") return undefined;
  if (event.data.role !== "user") return undefined;
  const text = typeof event.data.content === "string" ? event.data.content : "";
  // An empty message says nothing to judge; dropping it here keeps a blank trigger out of the domain.
  if (!text.trim()) return undefined;
  // A run without a conversation thread is its own conversation: the trigger still has a primary thread to evaluate on.
  const thread = event.threadId ?? event.runId;
  return {
    id: key("chat", event.runId, String(event.sequence)),
    source: CHAT_SOURCE_KIND,
    threads: [{ source: CHAT_SOURCE_KIND, id: thread }],
    actor: { source: CHAT_SOURCE_KIND, id: event.actorId },
    // Every chat message of the surface is written by a person; bots and CI reach the domain through other Sources.
    human: true,
    addressed: "direct",
    at: event.at,
    text,
    channel: {
      source: CHAT_SOURCE_KIND,
      thread: threadKey({ source: CHAT_SOURCE_KIND, id: thread }),
      address: {
        runId: event.runId,
        message: `${event.runId}:${event.sequence}`,
        ...(event.threadId ? { threadId: event.threadId } : {}),
      },
    },
    meta: { runId: event.runId, sequence: event.sequence, ...(event.threadId ? { threadId: event.threadId } : {}) },
  };
}

/**
 * The chat Source kind. The chat surface is the scope: the plugin listens to everything it translates and names the
 * `chat` admission row, whose cells the Policy's chat part owns. Out-of-scope messages therefore never arise from this
 * kind's own rule — the `filtered` path a disabled or unknown Source takes lives in the registry, and every translated
 * trigger goes to `receive` regardless, so the panel can explain what was dropped and why.
 */
export const chatSourceKind: SourceKind<ChatSourceConfig> = {
  kind: CHAT_SOURCE_KIND,
  title: "Chat",
  description: "Receives the messages people write in this workspace's chat.",
  schema: ChatConfigSchema,
  fields: [
    {
      key: "listen",
      type: "select",
      label: "Receive",
      options: [
        { value: "mentions", label: "Addressed to the agent only" },
        { value: "all", label: "All messages" },
      ],
    },
  ],
  health: [],
  scope(_input, config) {
    return { listened: true, observed: config.listen === "all", row: CHAT_SCOPE_ROW };
  },
  channel: {
    /** The address a chat reply needs: the run whose stream it renders into. */
    allowed: (address) => typeof address.runId === "string" && address.runId.length > 0,
    send: (host, message) => host.chatStream.send(message),
    link: (address) => ({ url: typeof address.url === "string" ? address.url : "", label: "Chat conversation" }),
  },
};

/** What one round did: `read` triggers received, `skipped` events read but not translatable. The adoption round reports zeros — it takes the position without reading. */
export type PollResult = { read: number; skipped: number };

/**
 * One read of the chat transcript: translate every event after the read position, pass each translatable one to
 * `receive` — the scope filters, storage, and fan-out happen inside the Engine — and only then move the position past
 * them. A round that throws leaves the position unchanged, so the next read replays the round; stable ids make the
 * replay a `duplicate` instead of a second trigger.
 *
 * A Source with no read position yet starts from now: the newest event becomes the position and nothing is ingested,
 * so enabling the chat Source does not replay the conversation's history as fresh triggers.
 */
export function pollChat(host: SourceContext): PollResult {
  const stored = host.state.get(CHAT_READ_CURSOR);
  if (stored === undefined) {
    const newest = host.events.latestSequence();
    if (newest !== undefined) host.state.set(CHAT_READ_CURSOR, String(newest));
    return { read: 0, skipped: 0 };
  }
  const after = Number(stored);
  if (!Number.isInteger(after) || after < 0)
    throw new Error(`The chat Source's read position is not a sequence: ${stored}`);
  const events = host.events.after(after);
  let read = 0;
  let skipped = 0;
  for (const event of events) {
    const trigger = chatTrigger(event);
    // The agent's own messages and non-message events produce no trigger and are skipped without a receive call.
    if (!trigger) {
      skipped += 1;
      continue;
    }
    host.receive(trigger);
    read += 1;
  }
  if (events.length) host.state.set(CHAT_READ_CURSOR, String(events[events.length - 1]!.sequence));
  return { read, skipped };
}

/** The block id a superagent reply renders as in the chat stream: one per outbox message, so a retry re-renders in place. */
export function chatBlockId(messageId: string): string {
  return `assistant:superagent:${messageId}`;
}

/**
 * The frame a superagent reply renders as in the chat stream, in the proxy's own vocabulary — a finished assistant
 * block the accumulator replaces in place, keyed by the outbox message id. This is the channel's whole claim on the
 * chat surface: it writes no transport, it hands the sink the frame the existing stream must carry.
 * @throws when the message's channel address names no run, since a frame without a run cannot route to a conversation.
 */
export function chatFrame(message: OutboundMessage, cursor: number): ChatFrame {
  const runId = message.channel.address.runId;
  if (typeof runId !== "string" || runId.length === 0)
    throw new Error("Missing chat reply target: no run in the channel address");
  return { type: "block", runId, blockId: chatBlockId(message.id), text: message.text, finishReason: null, cursor };
}
