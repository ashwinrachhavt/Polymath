import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gmailMailSender } from "@/domains/crm/mail-sender";
import { GmailSendRejectedError } from "@/domains/integrations/gmail/send";
import { SendOutcomeUnknownError, SenderNotConfiguredError } from "@/domains/crm/send-executor";

/*
 * The live MailSender adapter, with the provider behind a stubbed fetch so the
 * real Composio write path and RFC 2822 build run. What it exists to prove:
 *  - a deployment without COMPOSIO_API_KEY refuses before any network call;
 *  - a documented pre-dispatch refusal (the proxy's own 4xx) or the provider's
 *    4xx inside the proxy's 200 envelope is a failure, never an unknown;
 *  - anything unprovable (timeout, 5xx either side, a 200 without a message
 *    id) becomes SendOutcomeUnknownError, which blocks retry until reconciled;
 *  - the wire message carries the recipient, subject and attempt id exactly;
 *  - errors carry only the status, never the provider's error body.
 */

const INPUT = {
  to: "ada@example.test",
  subject: "Thursday works",
  body: "See you then.",
  providerConnectedAccountId: "ca_123",
  idempotencyKey: "attempt-1",
};

function stubFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: string }> = [];
  const spy = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return respond();
  });
  vi.stubGlobal("fetch", spy);
  return { spy, calls };
}

beforeEach(() => {
  // The Composio write path reads process.env; the adapter's own env argument
  // is the up-front refusal seam the capability panel mirrors.
  process.env.COMPOSIO_API_KEY = "k";
});

afterEach(() => {
  delete process.env.COMPOSIO_API_KEY;
  vi.unstubAllGlobals();
});

describe("gmailMailSender", () => {
  it("refuses before the network when COMPOSIO_API_KEY is unset", async () => {
    const { spy } = stubFetch(() => new Response("{}", { status: 200 }));
    const sender = gmailMailSender({});
    await expect(sender.send(INPUT)).rejects.toBeInstanceOf(SenderNotConfiguredError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns the provider ids on an accepted send", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ data: { id: "msg_1", threadId: "thr_1" }, status: 200, headers: {} }), {
          status: 200,
        }),
    );
    const sender = gmailMailSender(process.env);
    await expect(sender.send(INPUT)).resolves.toEqual({ providerObjectId: "msg_1", threadId: "thr_1" });
  });

  it("sends the exact recipient, subject and attempt marker through the Composio proxy", async () => {
    const { calls } = stubFetch(
      () => new Response(JSON.stringify({ data: { id: "msg_1", threadId: "thr_1" }, status: 200 }), { status: 200 }),
    );
    const sender = gmailMailSender(process.env);
    await sender.send(INPUT);
    expect(calls).toHaveLength(1);
    const request = JSON.parse(calls[0].body) as {
      connected_account_id: string;
      endpoint: string;
      method: string;
      body: { raw: string };
    };
    expect(request.connected_account_id).toBe("ca_123");
    expect(request.endpoint).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(request.method).toBe("POST");
    const raw = Buffer.from(request.body.raw, "base64url").toString("utf8");
    expect(raw).toContain("To: ada@example.test\r\n");
    expect(raw).toContain("Subject: Thursday works\r\n");
    expect(raw).toContain("Message-ID: <polymath-attempt-1@polymath.invalid>\r\n");
    expect(raw.endsWith("See you then.")).toBe(true);
  });

  it("the proxy's own 4xx is a documented pre-dispatch refusal: failed, never unknown", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "connected account not found", code: 404, slug: "x", status: 404 } }), {
          status: 404,
        }),
    );
    const sender = gmailMailSender(process.env);
    await expect(sender.send(INPUT)).rejects.toBeInstanceOf(GmailSendRejectedError);
  });

  it("the provider's 4xx inside the proxy's 200 envelope is a rejection, not a success", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ data: { error: { errors: [{ message: "insufficient permissions" }] } }, status: 403, headers: {} }),
          { status: 200 },
        ),
    );
    const sender = gmailMailSender(process.env);
    await expect(sender.send(INPUT)).rejects.toBeInstanceOf(GmailSendRejectedError);
  });

  it("a rejection error carries the status only, never the provider's error body", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ data: { error: { message: "secret diagnostic echoing To: ada@example.test" } }, status: 403 }),
          { status: 200 },
        ),
    );
    const sender = gmailMailSender(process.env);
    const failure = await sender.send(INPUT).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GmailSendRejectedError);
    expect((failure as Error).message).not.toContain("secret diagnostic");
    expect((failure as Error).message).not.toContain("ada@example.test");
  });

  it("the provider's 5xx inside the envelope proves nothing: unknown outcome", async () => {
    stubFetch(
      () => new Response(JSON.stringify({ data: { error: "backend error" }, status: 502, headers: {} }), { status: 200 }),
    );
    const sender = gmailMailSender(process.env);
    await expect(sender.send(INPUT)).rejects.toBeInstanceOf(SendOutcomeUnknownError);
  });

  it("the proxy's own 5xx proves nothing and becomes an unknown outcome", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: "internal", code: 500, slug: "x", status: 500 } }), { status: 500 }));
    const sender = gmailMailSender(process.env);
    await expect(sender.send(INPUT)).rejects.toBeInstanceOf(SendOutcomeUnknownError);
  });

  it("a network failure proves nothing and becomes an unknown outcome", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const sender = gmailMailSender(process.env);
    await expect(sender.send(INPUT)).rejects.toBeInstanceOf(SendOutcomeUnknownError);
  });

  it("a 200 without a message id proves nothing and becomes an unknown outcome", async () => {
    stubFetch(() => new Response(JSON.stringify({ data: {}, status: 200 }), { status: 200 }));
    const sender = gmailMailSender(process.env);
    await expect(sender.send(INPUT)).rejects.toBeInstanceOf(SendOutcomeUnknownError);
  });
});
