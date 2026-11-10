import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "@/components/chat/use-chat-stream";
import { STAGE_META } from "@/components/superagent/view";

/*
 * The chip send contract: the composer serializes what the chips already
 * fetched — never a fetch at send — and a chip whose fetch failed blocks the
 * send with its draft intact.
 *
 * Value: protects=the model reading context that matches what the chip showed;
 * fails_when=send re-resolves mentions over the network, a failed chip still
 * lets the message go, or a chip-free send changes one byte of the typed
 * text; why_new=the send path previously resolved mentions at submit
 * (mention-context.test.ts covers the serializer, not the surface wiring);
 * seam=ChatSurface under jsdom with the stream hook and the context fetch
 * mocked, the messages POST stubbed at global fetch; no_claim=the Radix
 * popover's pointer mechanics, the live SSE transport.
 */

const ann = { id: "p0000000-0000-0000-0000-000000000002", kind: "person", title: "Ann", href: "/contacts?p1" };
const bad = { id: "b9999999-9999-4999-8999-999999999999", kind: "person", title: "Broken", href: "/contacts?p2" };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/chat/use-chat-stream", () => ({
  useChatStream: () => mockChatState(),
}));

let mockChatState: () => ChatState;
function streamingState(): ChatState {
  return {
    blocks: [],
    tools: [],
    citations: [],
    connection: "streaming",
    error: null,
    retryable: true,
    lastFailedTurn: false,
    runFailed: false,
  };
}

vi.mock("@/app/(workspace)/polymath/mention-actions", () => ({
  fetchMentionContext: async (input: { kind: string; id: string }) => {
    if (input.id === bad.id) throw new Error("context service down");
    return { name: "Ann" };
  },
}));

vi.mock("@/app/(workspace)/polymath/chat-actions", () => ({
  startChatRun: async () => ({ ok: true, runId: "run-9" }),
}));

const posts: Array<{ url: string; body: string }> = [];

beforeEach(() => {
  posts.length = 0;
  mockChatState = streamingState;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/records/search")) {
        return new Response(JSON.stringify({ records: [ann, bad] }), { status: 200 });
      }
      if (init?.method === "POST" && url.includes("/messages")) {
        posts.push({ url, body: String(init.body) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderSurface() {
  render(
    createElement((await import("@/components/chat/chat-surface")).ChatSurface, {
      runId: "run-1",
      subject: { type: "artifact", id: "run-1" },
    }),
  );
  return screen.getByLabelText("Message") as HTMLTextAreaElement;
}

async function pick(title: string, draft: string) {
  const input = await renderSurface();
  fireEvent.change(input, {
    target: { value: draft, selectionStart: draft.length, selectionEnd: draft.length },
  });
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(title) }));
  return input;
}

const sendButton = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;

describe("ChatSurface context chips", () => {
  it("sends byte-identical text when no chip is present", async () => {
    const input = await renderSurface();
    fireEvent.change(input, { target: { value: "Plain words" } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(posts[0].body).message).toBe("Plain words");
  });

  it("appends the chip's block and nothing else when a chip is present", async () => {
    await pick("Ann", "Hey @Ann");
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(posts).toHaveLength(1));
    const message = JSON.parse(posts[0].body).message as string;
    expect(message.startsWith("Hey @Ann")).toBe(true);
    expect(message).toMatch(/\n\[context:mention id=p0000000-0000-0000-0000-000000000002\]\n\{.*\}$/);
  });

  it("blocks the send while a chip's fetch failed and leaves the draft alone", async () => {
    await pick("Broken", "Hey @Broken");
    await screen.findByText("Retry");
    expect(sendButton().disabled).toBe(true);
    expect(posts).toHaveLength(0);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Hey @Broken");
  });
});

/*
 * The stage chip's honesty contract: the Reviews agent views is the honest
 * surface — it classifies the run's own report and says "Failed" — and the
 * conversation window's chip must agree with it, speaking the panel's word
 * from the panel's table (STAGE_META). Whatever the stream's transport is
 * doing, a failed stage never reads as "Working".
 */
describe("ChatSurface stage chip", () => {
  it("renders the panel's failed vocabulary for a failed run, never Working", async () => {
    // The defect's exact shape: the transport is mid-flight while the run's
    // report is failed — a reconnect that has not replayed the end frame yet.
    // The old chip read the transport here and said "Working".
    mockChatState = () => ({ ...streamingState(), connection: "streaming", runFailed: true });
    await renderSurface();
    expect(screen.getByText(STAGE_META["person-failed"].label)).toBeTruthy();
    expect(screen.queryByText("Working")).toBeNull();
  });

  it("renders the panel's failed vocabulary for a failed turn waiting on a person", async () => {
    // The panel's ticketStage reads a failed report with no newer human
    // message as person-failed; the chip says the same word.
    mockChatState = () => ({ ...streamingState(), connection: "waiting", lastFailedTurn: true });
    await renderSurface();
    expect(screen.getByText(STAGE_META["person-failed"].label)).toBeTruthy();
    expect(screen.queryByText("Working")).toBeNull();
  });

  it("keeps Working for a live stream whose run has not failed", async () => {
    mockChatState = streamingState;
    await renderSurface();
    expect(screen.getByText(STAGE_META.working.label)).toBeTruthy();
  });

  it("carries the failed vocabulary to the headerless quiet line", async () => {
    mockChatState = () => ({ ...streamingState(), connection: "waiting", lastFailedTurn: true });
    render(
      createElement((await import("@/components/chat/chat-surface")).ChatSurface, {
        runId: "run-1",
        subject: { type: "artifact", id: "run-1" },
        showHeader: false,
      }),
    );
    expect(screen.getByRole("status").textContent).toBe(STAGE_META["person-failed"].label);
  });
});
