import { describe, expect, it } from "vitest";
import searchFixture from "../fixtures/gmail/search.json";
import threadFixture from "../fixtures/gmail/thread.json";
import { fixtureTransport } from "../helpers/fixture-transport";
import { readGmailThread, searchGmailMessages } from "@/domains/integrations/gmail/reads";
import type { Transport, TransportRequest } from "@/domains/integrations/transport";

/*
 * Gmail reads, exercised against the recorded provider shapes. Every test goes
 * through `fixtureTransport`, which throws on an unmatched endpoint — so a read
 * that invents a URL fails here instead of against Gmail.
 */

const MESSAGES = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const THREADS = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
const CONNECTED_ACCOUNT = "ca_fixture";

const alphaDetail = threadFixture.messages[0];

function detailFor(id: string, threadId: string, headers: Array<{ name: string; value: string }>) {
  return { id, threadId, payload: { mimeType: "text/plain", headers } };
}

/** Records what the read asked for while delegating to the strict fixture. */
function recording(inner: Transport): { transport: Transport; requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  return {
    requests,
    transport: {
      read(request) {
        requests.push(request);
        return inner.read(request);
      },
    },
  };
}

describe("searchGmailMessages", () => {
  it("maps both hits of a two-hit search with header values and newest-first order", async () => {
    const transport = fixtureTransport([
      {
        method: "GET",
        endpointPrefix: `${MESSAGES}/msg_fixture_alpha`,
        status: 200,
        body: detailFor("msg_fixture_alpha", "thr_fixture_alpha", [
          { name: "From", value: "alpha@example.invalid" },
          { name: "Subject", value: "Alpha subject" },
          { name: "Date", value: "Mon, 20 Oct 2025 09:00:00 +0000" },
        ]),
      },
      {
        method: "GET",
        endpointPrefix: `${MESSAGES}/msg_fixture_beta`,
        status: 200,
        body: detailFor("msg_fixture_beta", "thr_fixture_beta", [
          // Lower-case casing proves the lookup is case-insensitive.
          { name: "from", value: "beta@example.invalid" },
          { name: "subject", value: "Beta subject" },
          { name: "Date", value: "Tue, 21 Oct 2025 09:00:00 +0000" },
        ]),
      },
      { method: "GET", endpointPrefix: MESSAGES, status: 200, body: searchFixture },
    ]);

    const result = await searchGmailMessages(transport, {
      connectedAccountId: CONNECTED_ACCOUNT,
      query: "in:inbox",
      limit: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages.map((message) => message.id)).toEqual(["msg_fixture_beta", "msg_fixture_alpha"]);
    expect(result.messages[0]).toMatchObject({
      from: "beta@example.invalid",
      subject: "Beta subject",
      date: "Tue, 21 Oct 2025 09:00:00 +0000",
      threadId: "thr_fixture_beta",
      snippet: "Fixture snippet beta. Nothing here is real.",
    });
    expect(result.messages[1]).toMatchObject({
      from: "alpha@example.invalid",
      subject: "Alpha subject",
    });
  });

  it("returns null for a header the message lacks, never an empty string", async () => {
    const transport = fixtureTransport([
      {
        method: "GET",
        endpointPrefix: `${MESSAGES}/msg_fixture_alpha`,
        status: 200,
        body: detailFor("msg_fixture_alpha", "thr_fixture_alpha", [
          { name: "From", value: "alpha@example.invalid" },
        ]),
      },
      {
        method: "GET",
        endpointPrefix: `${MESSAGES}/msg_fixture_beta`,
        status: 200,
        body: detailFor("msg_fixture_beta", "thr_fixture_beta", [{ name: "From", value: "beta@example.invalid" }]),
      },
      { method: "GET", endpointPrefix: MESSAGES, status: 200, body: searchFixture },
    ]);

    const result = await searchGmailMessages(transport, {
      connectedAccountId: CONNECTED_ACCOUNT,
      query: "in:inbox",
      limit: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages[0].subject).toBeNull();
    expect(result.messages[0].date).toBeNull();
  });

  it("clamps a limit above 100 to 100 at the provider", async () => {
    const { transport, requests } = recording(
      fixtureTransport([{ method: "GET", endpointPrefix: MESSAGES, status: 200, body: { messages: [] } }]),
    );

    const result = await searchGmailMessages(transport, {
      connectedAccountId: CONNECTED_ACCOUNT,
      query: "in:inbox",
      limit: 1000,
    });

    expect(result).toEqual({ ok: true, messages: [] });
    expect(requests[0].query?.maxResults).toBe("100");
  });

  it("treats an empty result as a success", async () => {
    const transport = fixtureTransport([
      { method: "GET", endpointPrefix: MESSAGES, status: 200, body: { resultSizeEstimate: 0 } },
    ]);

    await expect(
      searchGmailMessages(transport, { connectedAccountId: CONNECTED_ACCOUNT, query: "nothing", limit: 5 }),
    ).resolves.toEqual({ ok: true, messages: [] });
  });

  it("surfaces a 401 as a typed failure rather than throwing", async () => {
    const transport = fixtureTransport([
      { method: "GET", endpointPrefix: MESSAGES, status: 401, body: { error: { code: 401 } } },
    ]);

    const result = await searchGmailMessages(transport, {
      connectedAccountId: CONNECTED_ACCOUNT,
      query: "in:inbox",
      limit: 5,
    });

    expect(result).toEqual({ ok: false, code: "provider_error", message: expect.any(String) });
  });

  it("fails on a malformed list body instead of returning a partial result", async () => {
    const transport = fixtureTransport([
      { method: "GET", endpointPrefix: MESSAGES, status: 200, body: { messages: [{ threadId: "missing-id" }] } },
    ]);

    const result = await searchGmailMessages(transport, {
      connectedAccountId: CONNECTED_ACCOUNT,
      query: "in:inbox",
      limit: 5,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("malformed_response");
  });

  it("runs detail reads with bounded concurrency while preserving order", async () => {
    const count = 12;
    // Zero-padded so no id is a prefix of another; routes match with startsWith.
    const ids = Array.from({ length: count }, (_, index) => `msg_fixture_${String(index).padStart(2, "0")}`);
    // The list route prefix also matches every detail endpoint, so detail routes
    // must come first; fixtureTransport takes the first match.
    const inner = fixtureTransport([
      ...ids.map((id, index) => ({
        method: "GET" as const,
        endpointPrefix: `${MESSAGES}/${id}`,
        status: 200,
        // Newer for the later index, so newest-first reverses the list order and
        // an implementation that pushed as responses arrived would be caught.
        body: detailFor(id, `thr_${id}`, [
          { name: "From", value: `${id}@example.invalid` },
          { name: "Date", value: new Date(Date.UTC(2025, 0, 1 + index)).toUTCString() },
        ]),
      })),
      {
        method: "GET",
        endpointPrefix: MESSAGES,
        status: 200,
        body: { messages: ids.map((id) => ({ id, threadId: `thr_${id}` })) },
      },
    ]);

    let inFlight = 0;
    let peak = 0;
    const transport: Transport = {
      async read(request) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Hold each call briefly so overlapping requests are observable.
        await new Promise((resolve) => setTimeout(resolve, 1));
        try {
          return await inner.read(request);
        } finally {
          inFlight -= 1;
        }
      },
    };

    const result = await searchGmailMessages(transport, {
      connectedAccountId: CONNECTED_ACCOUNT,
      query: "in:inbox",
      limit: count,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
    expect(result.messages.map((message) => message.id)).toEqual([...ids].reverse());
  });

  it("fails the whole search when any detail read fails", async () => {
    const transport = fixtureTransport([
      {
        method: "GET",
        endpointPrefix: `${MESSAGES}/msg_fixture_alpha`,
        status: 200,
        body: detailFor("msg_fixture_alpha", "thr_fixture_alpha", [{ name: "From", value: "a@example.invalid" }]),
      },
      { method: "GET", endpointPrefix: `${MESSAGES}/msg_fixture_beta`, status: 500, body: {} },
      { method: "GET", endpointPrefix: MESSAGES, status: 200, body: searchFixture },
    ]);

    const result = await searchGmailMessages(transport, {
      connectedAccountId: CONNECTED_ACCOUNT,
      query: "in:inbox",
      limit: 10,
    });

    expect(result).toEqual({ ok: false, code: "provider_error", message: expect.any(String) });
  });

  it("throws when the read asks for an endpoint the fixture does not cover", async () => {
    // Only the list endpoint is recorded. The detail read has no route, and the
    // strict transport must fail loudly rather than let a wrong endpoint pass.
    const strict = fixtureTransport([]);
    const transport: Transport = {
      read(request) {
        if (request.endpoint === MESSAGES) {
          return Promise.resolve({ ok: true, status: 200, data: searchFixture });
        }
        return strict.read(request);
      },
    };

    await expect(
      searchGmailMessages(transport, { connectedAccountId: CONNECTED_ACCOUNT, query: "in:inbox", limit: 10 }),
    ).rejects.toThrow(/no route for GET/);
  });
});

describe("readGmailThread", () => {
  it("reads a multipart thread and yields its text/plain body", async () => {
    const transport = fixtureTransport([
      { method: "GET", endpointPrefix: `${THREADS}/thr_fixture_alpha`, status: 200, body: threadFixture },
    ]);

    const result = await readGmailThread(transport, {
      connectedAccountId: CONNECTED_ACCOUNT,
      threadId: "thr_fixture_alpha",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: alphaDetail.id,
      from: "fixture-sender@example.invalid",
      subject: "Fixture thread subject",
      date: null,
      // The body is decoded verbatim, newline included; the read does not
      // reformat what the provider sent.
      bodyText: "Fixture body: one plain-text part.\r\n",
    });
  });

  it("falls back to html stripped of tags when there is no text/plain part", async () => {
    const transport = fixtureTransport([
      {
        method: "GET",
        endpointPrefix: `${THREADS}/thr_fixture_alpha`,
        status: 200,
        body: {
          id: "thr_fixture_alpha",
          messages: [
            {
              id: "msg_fixture_alpha",
              threadId: "thr_fixture_alpha",
              payload: {
                mimeType: "text/html",
                headers: [{ name: "Subject", value: "Html only" }],
                body: { data: Buffer.from("<p>Hello <b>there</b></p>").toString("base64url") },
              },
            },
          ],
        },
      },
    ]);

    const result = await readGmailThread(transport, {
      connectedAccountId: CONNECTED_ACCOUNT,
      threadId: "thr_fixture_alpha",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages[0].bodyText).toBe("Hello there");
  });

  it("yields nulls for a message with no payload", async () => {
    const transport = fixtureTransport([
      {
        method: "GET",
        endpointPrefix: `${THREADS}/thr_fixture_alpha`,
        status: 200,
        body: { id: "thr_fixture_alpha", messages: [{ id: "msg_fixture_alpha", threadId: "thr_fixture_alpha" }] },
      },
    ]);

    const result = await readGmailThread(transport, {
      connectedAccountId: CONNECTED_ACCOUNT,
      threadId: "thr_fixture_alpha",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages[0]).toEqual({
      id: "msg_fixture_alpha",
      threadId: "thr_fixture_alpha",
      from: null,
      subject: null,
      date: null,
      snippet: null,
      bodyText: null,
    });
  });

  it("surfaces a 401 as a typed failure rather than throwing", async () => {
    const transport = fixtureTransport([
      { method: "GET", endpointPrefix: `${THREADS}/thr_fixture_alpha`, status: 401, body: { error: { code: 401 } } },
    ]);

    const result = await readGmailThread(transport, {
      connectedAccountId: CONNECTED_ACCOUNT,
      threadId: "thr_fixture_alpha",
    });

    expect(result).toEqual({ ok: false, code: "provider_error", message: expect.any(String) });
  });

  it("builds the path from users/me and never from the caller's thread id alone", async () => {
    const { transport, requests } = recording(
      fixtureTransport([
        { method: "GET", endpointPrefix: `${THREADS}/`, status: 200, body: { messages: [] } },
      ]),
    );

    await readGmailThread(transport, { connectedAccountId: CONNECTED_ACCOUNT, threadId: "thr/../../x?y" });

    // The id is one encoded path segment, so traversal characters cannot escape
    // the thread path.
    expect(requests[0].endpoint).toBe(`${THREADS}/thr%2F..%2F..%2Fx%3Fy`);
    expect(requests[0].query).toEqual({ format: "full" });
  });
});
