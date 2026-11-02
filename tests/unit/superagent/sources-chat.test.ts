/** The chat Source's specs: translation, scope, the read position, and the channel — ported from the prototype's source specs. */
import { describe, expect, it, vi } from "vitest";
import { ChatAccumulator, decodeFrame } from "@/domains/agents/stream-contract";
import {
  MemoryRepositories,
  createEngine,
  threadKey,
  type Assessor,
  type Executor,
  type OutboundMessage,
  type Outbox,
  type Policy,
  type ReceiveResult,
  type Trigger,
} from "@/domains/superagent/core";
import {
  CHAT_READ_CURSOR,
  CHAT_SCOPE_ROW,
  CHAT_SOURCE_KIND,
  SourceRegistry,
  chatBlockId,
  chatFrame,
  chatSourceKind,
  chatTrigger,
  pollChat,
  type ChatEvent,
  type SourceContext,
} from "@/domains/superagent/sources";

/** One chat transcript event as the host's reader returns it. */
function event(overrides: Partial<ChatEvent> = {}): ChatEvent {
  return {
    runId: "run-1",
    sequence: 3,
    type: "message",
    data: { role: "user", content: "Ship the report" },
    actorId: "user-1",
    threadId: "thread-1",
    at: "2026-11-02T00:00:03.000Z",
    ...overrides,
  };
}

let clock = 0;
const policy: Policy = {
  version: "v1",
  paused: false,
  // A person's addressed message is an explicit request; nothing else admits in these specs.
  gate: (t) =>
    t.human && t.addressed
      ? { admissible: true, strength: "explicit", basis: { via: "listed" } }
      : { admissible: false, reason: "not an explicit request" },
  revalidate: () => true,
  admitsInferred: () => false,
  evalTimeoutMs: 60_000,
};
const assessor: Assessor = { request: vi.fn(), release: vi.fn() };
const executor: Executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() };
const outbox: Outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() };

/** The host over a real engine: receive runs intake and then the clock, exactly as the cutover wiring will. */
function host({ config = { listen: "mentions" } as Record<string, unknown>, events = [] as ChatEvent[] } = {}) {
  const repo = new MemoryRepositories();
  const sources = new SourceRegistry((kind) => (kind === CHAT_SOURCE_KIND ? config : undefined));
  sources.register(chatSourceKind);
  const engine = createEngine({
    repo,
    scope: sources.scope(),
    policy: () => policy,
    assessor,
    executor,
    outbox,
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)).toISOString(),
  });
  const receive = vi.fn((trigger: Trigger): ReceiveResult => {
    const result = engine.receive(trigger);
    engine.evaluateDue();
    return result;
  });
  const state = new Map<string, string>();
  const ctx: SourceContext = {
    config: (kind) => (kind === CHAT_SOURCE_KIND ? config : undefined),
    receive,
    state: {
      get: (key) => state.get(key),
      set: (key, value) => {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
      },
    },
    events: {
      latestSequence: () => events.at(-1)?.sequence,
      after: (after) => events.filter((item) => item.sequence > after),
    },
    chatStream: { send: vi.fn(async () => "sent" as const) },
  };
  return { ctx, repo, engine, receive, state, events };
}

describe("chatTrigger", () => {
  it("yields the same trigger id for the same message, and different ids for different messages", () => {
    const first = chatTrigger(event());
    const again = chatTrigger(event());
    const other = chatTrigger(event({ sequence: 4 }));
    expect(first).toBeDefined();
    expect(first!.id).toBe(again!.id);
    expect(other!.id).not.toBe(first!.id);
  });

  it("produces no trigger for the agent's own messages and non-message events", () => {
    expect(chatTrigger(event({ data: { role: "assistant", content: "On it" } }))).toBeUndefined();
    expect(chatTrigger(event({ data: { role: "system", content: "restarted" } }))).toBeUndefined();
    expect(chatTrigger(event({ data: { role: "tool", content: "{}" } }))).toBeUndefined();
    expect(chatTrigger(event({ type: "objective", data: { content: "the run's brief" } }))).toBeUndefined();
    expect(chatTrigger(event({ type: "turn.completed" }))).toBeUndefined();
    // A message that says nothing is not a person's utterance either.
    expect(chatTrigger(event({ data: { role: "user", content: "   " } }))).toBeUndefined();
  });

  it("translates a person's message into a direct, human trigger on the conversation's thread", () => {
    const trigger = chatTrigger(event())!;
    expect(trigger.source).toBe("chat");
    expect(trigger.threads).toEqual([{ source: "chat", id: "thread-1" }]);
    expect(trigger.actor).toEqual({ source: "chat", id: "user-1" });
    expect(trigger.human).toBe(true);
    expect(trigger.addressed).toBe("direct");
    expect(trigger.at).toBe("2026-11-02T00:00:03.000Z");
    expect(trigger.text).toBe("Ship the report");
    expect(trigger.channel?.thread).toBe("chat:thread-1");
    expect(trigger.channel?.address).toEqual({ runId: "run-1", message: "run-1:3", threadId: "thread-1" });
    expect(trigger.meta).toEqual({ runId: "run-1", sequence: 3, threadId: "thread-1" });
  });

  it("makes an unthreaded run its own conversation rather than dropping it", () => {
    const trigger = chatTrigger(event({ threadId: undefined }))!;
    expect(trigger.threads).toEqual([{ source: "chat", id: "run-1" }]);
    expect(trigger.channel?.thread).toBe(threadKey({ source: "chat", id: "run-1" }));
  });
});

describe("the chat Source's scope", () => {
  it("listens to everything it translates, observing unaddressed messages only in the all mode", () => {
    const mentions = new SourceRegistry(() => ({ listen: "mentions" }));
    mentions.register(chatSourceKind);
    expect(mentions.scope().scope({ source: "chat", meta: {} })).toEqual({
      listened: true,
      observed: false,
      row: CHAT_SCOPE_ROW,
    });
    const all = new SourceRegistry(() => ({ listen: "all" }));
    all.register(chatSourceKind);
    expect(all.scope().scope({ source: "chat", meta: {} })).toEqual({
      listened: true,
      observed: true,
      row: CHAT_SCOPE_ROW,
    });
  });

  it("fills the conservative default, and a source that is off, unknown, or misconfigured listens to nothing", () => {
    const defaults = new SourceRegistry(() => ({}));
    defaults.register(chatSourceKind);
    expect(defaults.scope().scope({ source: "chat", meta: {} })).toEqual({
      listened: true,
      observed: false,
      row: CHAT_SCOPE_ROW,
    });
    expect(defaults.scope().scope({ source: "feishu", meta: {} })).toEqual({
      listened: false,
      reason: "unknownSource",
    });
    const off = new SourceRegistry(() => undefined);
    off.register(chatSourceKind);
    expect(off.scope().scope({ source: "chat", meta: {} })).toEqual({ listened: false, reason: "sourceOff" });
    const broken = new SourceRegistry(() => ({ listen: "sometimes" }));
    broken.register(chatSourceKind);
    expect(broken.scope().scope({ source: "chat", meta: {} })).toEqual({
      listened: false,
      reason: "sourceConfigInvalid",
    });
  });

  it("passes a trigger that is not listened to through receive, which stores it filtered for the panel to explain", () => {
    const h = host({ config: undefined });
    const trigger: Trigger = { ...chatTrigger(event())!, source: "feishu" };
    expect(h.engine.receive(trigger)).toBe("filtered");
    expect(h.repo.triggers.get(trigger.id)).toBeDefined();
    expect(h.repo.triggers.disposition(trigger.id)?.filtered).toEqual({ code: "unknownSource" });
  });
});

describe("pollChat", () => {
  it("starts from now on its first read: it takes the position and ingests nothing", () => {
    const h = host({
      events: [event({ sequence: 1 }), event({ sequence: 2, data: { role: "assistant", content: "On it" } })],
    });
    // Adoption reads no events, so it cannot count what it skipped — it takes the position and ingests nothing.
    expect(pollChat(h.ctx)).toEqual({ read: 0, skipped: 0 });
    expect(h.state.get(CHAT_READ_CURSOR)).toBe("2");
    expect(h.receive).not.toHaveBeenCalled();
  });

  it("reads the events after its position, receives every person's message once, and moves the position past them", () => {
    const h = host({
      events: [
        event({ sequence: 1, data: { role: "assistant", content: "On it" } }),
        event({ sequence: 2 }),
        event({ sequence: 3, data: { role: "user", content: "And the deck?" } }),
      ],
    });
    h.state.set(CHAT_READ_CURSOR, "0");
    expect(pollChat(h.ctx)).toEqual({ read: 2, skipped: 1 });
    expect(h.receive).toHaveBeenCalledTimes(2);
    expect(h.receive.mock.results.map((item) => item.value)).toEqual(["stored", "stored"]);
    expect(h.state.get(CHAT_READ_CURSOR)).toBe("3");
    // The translated triggers reached the engine whole: an explicit request on the conversation's thread.
    const [first] = h.receive.mock.calls[0]!;
    expect(first.id).toBe(chatTrigger(event({ sequence: 2 }))!.id);
    expect(h.engine.candidate(first.id)?.strength).toBe("explicit");
  });

  it("keeps the position when a round is cut short, so the next read replays it", () => {
    const h = host({ events: [event({ sequence: 1 }), event({ sequence: 2 })] });
    h.state.set(CHAT_READ_CURSOR, "0");
    h.receive.mockImplementationOnce(() => {
      throw new Error("the store is down");
    });
    expect(() => pollChat(h.ctx)).toThrow("the store is down");
    expect(h.state.get(CHAT_READ_CURSOR)).toBe("0");
  });

  it("stores a replayed round as duplicates instead of second triggers", () => {
    const h = host({ events: [event({ sequence: 1 }), event({ sequence: 2 })] });
    h.state.set(CHAT_READ_CURSOR, "0");
    expect(pollChat(h.ctx).read).toBe(2);
    // The position is lost — a restored backup, a cleared KV — and the round is read again.
    h.state.set(CHAT_READ_CURSOR, "0");
    expect(pollChat(h.ctx).read).toBe(2);
    expect(h.receive.mock.results.map((item) => item.value)).toEqual(["stored", "stored", "duplicate", "duplicate"]);
    const ids = new Set(h.receive.mock.calls.map(([trigger]) => trigger.id));
    expect(ids.size).toBe(2);
  });
});

describe("the chat channel", () => {
  const message: OutboundMessage = {
    id: "reply-1",
    channel: {
      source: "chat",
      thread: "chat:thread-1",
      address: { runId: "run-1", message: "run-1:3", threadId: "thread-1" },
    },
    text: "The report is ready.",
    kind: "reply",
  };

  it("sends through the host's chat stream and reports its verdict verbatim", async () => {
    const h = host();
    await expect(chatSourceKind.channel!.send(h.ctx, message)).resolves.toBe("sent");
    expect(h.ctx.chatStream.send).toHaveBeenCalledWith(message);
    const gone = host();
    (gone.ctx.chatStream.send as ReturnType<typeof vi.fn>).mockResolvedValue("gone");
    await expect(chatSourceKind.channel!.send(gone.ctx, message)).resolves.toBe("gone");
  });

  it("throws when delivery may still succeed, so the outbox retries instead of dropping", async () => {
    const h = host();
    (h.ctx.chatStream.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("the stream is down"));
    await expect(chatSourceKind.channel!.send(h.ctx, message)).rejects.toThrow("the stream is down");
  });

  it("allows addresses that name a run and links the ones that carry a url", () => {
    expect(chatSourceKind.channel!.allowed?.({ runId: "run-1" }, { listen: "mentions" })).toBe(true);
    expect(chatSourceKind.channel!.allowed?.({ message: "run-1:3" }, { listen: "mentions" })).toBe(false);
    expect(chatSourceKind.channel!.link({ url: "https://polymath.test/x" })).toEqual({
      url: "https://polymath.test/x",
      label: "Chat conversation",
    });
    expect(chatSourceKind.channel!.link({})).toEqual({ url: "", label: "Chat conversation" });
  });
});

describe("chatFrame", () => {
  const message: OutboundMessage = {
    id: "reply-1",
    channel: { source: "chat", thread: "chat:thread-1", address: { runId: "run-1", message: "run-1:3" } },
    text: "The report is ready.",
    kind: "reply",
  };

  it("renders a reply as a finished assistant block of the existing chat stream, keyed by the message id", () => {
    const frame = chatFrame(message, 7);
    expect(frame).toEqual({
      type: "block",
      runId: "run-1",
      blockId: chatBlockId("reply-1"),
      text: "The report is ready.",
      finishReason: null,
      cursor: 7,
    });
    expect(chatBlockId("reply-1")).toBe(chatBlockId("reply-1"));
  });

  it("round-trips through the stream contract and renders in place when a retry writes it again", () => {
    const accumulator = new ChatAccumulator();
    const decoded = decodeFrame(JSON.stringify(chatFrame(message, 7)));
    expect(decoded).toEqual(chatFrame(message, 7));
    accumulator.apply(decoded!);
    accumulator.apply(decoded!);
    expect(accumulator.list()).toEqual([
      { id: chatBlockId("reply-1"), kind: "assistant", text: "The report is ready.", done: true, messageId: null },
    ]);
    // A retry at a later cursor re-renders the same block in place, never twice.
    accumulator.apply(decodeFrame(JSON.stringify(chatFrame(message, 8)))!);
    expect(accumulator.list()).toHaveLength(1);
  });

  it("refuses to render a reply whose address names no run", () => {
    const orphan: OutboundMessage = {
      ...message,
      channel: { source: "chat", thread: "chat:thread-1", address: { message: "run-1:3" } },
    };
    expect(() => chatFrame(orphan, 1)).toThrow("Missing chat reply target");
  });
});
