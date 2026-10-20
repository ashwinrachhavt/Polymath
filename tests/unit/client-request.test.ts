import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "@/lib/client-request";

/*
 * The client request layer is the only thing between a browser island and
 * /api/v1. These tests pin the mapping each failure class gets, because the
 * copy is user-facing: an aborted request must say it was cancelled, and a
 * malformed success body must not read as a server outage.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function problem(status: number, body: unknown, contentType = "application/problem+json") {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

describe("requestJson status mapping", () => {
  const cases: Array<[number, string]> = [
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [422, "validation"],
    [429, "rate_limited"],
    [500, "server"],
  ];

  it.each(cases)("%i maps to %s with copy", async (status, kind) => {
    fetchMock.mockResolvedValue(new Response("", { status }));
    const result = await requestJson("/api/v1/things");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe(kind);
    expect(result.failure.title.length).toBeGreaterThan(0);
    expect(result.failure.title).not.toMatch(/</);
  });

  it("a problem+json body keeps its machine code and title", async () => {
    fetchMock.mockResolvedValue(
      problem(409, {
        type: "https://axiom.dev/problems/version_conflict",
        code: "version_conflict",
        title: "This note changed since you loaded it.",
        status: 409,
      }),
    );
    const result = await requestJson("/api/v1/notes/1", { method: "PATCH", body: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("conflict");
    expect(result.failure.code).toBe("version_conflict");
    expect(result.failure.title).toBe("This note changed since you loaded it.");
  });

  it("no code field when the body carries none", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));
    const result = await requestJson("/api/v1/notes");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("forbidden");
    expect(result.failure.code).toBeUndefined();
  });

  it("an HTML error page never leaks into the title", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html><body>stack trace at secret.js:1</body></html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await requestJson("/api/v1/things");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("server");
    expect(result.failure.title).not.toContain("secret");
    expect(result.failure.title).not.toContain("<");
  });
});

describe("requestJson success bodies", () => {
  it("returns parsed data", async () => {
    fetchMock.mockResolvedValue(Response.json({ id: "n-1" }));
    const result = await requestJson<{ id: string }>("/api/v1/notes/n-1");
    expect(result).toEqual({ ok: true, data: { id: "n-1" } });
  });

  it("a non-JSON 200 is malformed, not server", async () => {
    fetchMock.mockResolvedValue(
      new Response("not json at all", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const result = await requestJson("/api/v1/notes");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("malformed");
    expect(result.failure.title).toMatch(/could not be read/i);
  });

  it("an empty 200 is malformed: the endpoint promised a body and sent none", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const result = await requestJson("/api/v1/notes");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("malformed");
  });

  it("a JSON null 200 is malformed", async () => {
    fetchMock.mockResolvedValue(Response.json(null));
    const result = await requestJson("/api/v1/notes");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("malformed");
  });
});

describe("requestJson transport failures", () => {
  it("an AbortError is aborted, not network, and says it was cancelled", async () => {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    fetchMock.mockRejectedValue(error);
    const result = await requestJson("/api/v1/notes", { signal: new AbortController().signal });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("aborted");
    expect(result.failure.kind).not.toBe("network");
    expect(result.failure.title).toMatch(/cancelled/i);
    expect(result.failure.title).not.toMatch(/connection/i);
  });

  it("a DOMException AbortError is also aborted", async () => {
    fetchMock.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    const result = await requestJson("/api/v1/notes");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("aborted");
  });

  it("a TypeError from fetch is network", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await requestJson("/api/v1/notes");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("network");
    expect(result.failure.title).toMatch(/did not reach the server/i);
  });
});

describe("requestJson request shape", () => {
  it("sends the idempotency key header when one is given", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    await requestJson("/api/v1/notes", {
      method: "POST",
      body: { title: "x" },
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ title: "x" }));
  });

  it("omits the idempotency key header when none is given", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    await requestJson("/api/v1/notes");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBeUndefined();
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });
});
