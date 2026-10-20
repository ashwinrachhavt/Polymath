import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import content from "../fixtures/gmail/search.json";
import { fixtureTransport } from "../helpers/fixture-transport";
import { composioTransport, type TransportRequest } from "@/domains/integrations/transport";

/*
 * The transport seam. Four properties matter and each has a test below:
 *  - a write-shaped method never reaches the provider (the seam is read-only);
 *  - a 401 keeps its status, so the gateway can tell a revoked credential from
 *    an outage;
 *  - an unparseable body is a failure, never an empty success;
 *  - the fixture transport throws on an unmatched request instead of inventing a
 *    response that would hide a wrong endpoint.
 */

const GMAIL_MESSAGES = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

describe("composioTransport", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns the parsed provider body and a success status", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: content }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await composioTransport.read({
      connectedAccountId: "ca_fixture",
      endpoint: GMAIL_MESSAGES,
      method: "GET",
    });

    expect(result).toEqual({ ok: true, status: 200, data: content });
  });

  it("never sends a write-shaped method to fetch", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // The type forbids this; the cast proves the runtime guard still holds if a
    // caller reaches the seam from untyped code.
    for (const method of ["POST", "DELETE"] as const) {
      const request = {
        connectedAccountId: "ca_fixture",
        endpoint: GMAIL_MESSAGES,
        method,
      } as unknown as TransportRequest;
      await expect(composioTransport.read(request)).rejects.toThrow(/only reads may run/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a provider 401 to provider_error with status 401", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );

    const result = await composioTransport.read({
      connectedAccountId: "ca_fixture",
      endpoint: GMAIL_MESSAGES,
      method: "GET",
    });

    expect(result).toMatchObject({ ok: false, code: "provider_error", status: 401 });
  });

  it("maps an unparseable body to provider_error, not an empty success", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("not json");
        },
      }),
    );

    const result = await composioTransport.read({
      connectedAccountId: "ca_fixture",
      endpoint: GMAIL_MESSAGES,
      method: "GET",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.code).toBe("provider_error");
  });

  it("reports not_configured without a status when no key is set", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await composioTransport.read({
      connectedAccountId: "ca_fixture",
      endpoint: GMAIL_MESSAGES,
      method: "GET",
    });

    expect(result).toEqual({ ok: false, code: "not_configured", message: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fixtureTransport", () => {
  it("serves a matching route", async () => {
    const transport = fixtureTransport([
      { method: "GET", endpointPrefix: "https://gmail.googleapis.com/gmail/v1/users/me/messages", status: 200, body: content },
    ]);

    const result = await transport.read({
      connectedAccountId: "ca_fixture",
      endpoint: GMAIL_MESSAGES,
      method: "GET",
    });

    expect(result).toEqual({ ok: true, status: 200, data: content });
  });

  it("throws on an unmatched endpoint", async () => {
    const transport = fixtureTransport([
      { method: "GET", endpointPrefix: "https://gmail.googleapis.com/gmail/v1/users/me/threads", status: 200, body: {} },
    ]);

    await expect(
      transport.read({ connectedAccountId: "ca_fixture", endpoint: GMAIL_MESSAGES, method: "GET" }),
    ).rejects.toThrow(/no route for GET/);
  });

  it("throws when the method does not match", async () => {
    const transport = fixtureTransport([
      { method: "HEAD", endpointPrefix: "https://gmail.googleapis.com/gmail/v1/users/me/messages", status: 200, body: {} },
    ]);

    await expect(
      transport.read({ connectedAccountId: "ca_fixture", endpoint: GMAIL_MESSAGES, method: "GET" }),
    ).rejects.toThrow(/no route for GET/);
  });

  it("maps a recorded error status to provider_error", async () => {
    const transport = fixtureTransport([
      { method: "GET", endpointPrefix: "https://gmail.googleapis.com/gmail/v1/users/me/messages", status: 401, body: {} },
    ]);

    const result = await transport.read({
      connectedAccountId: "ca_fixture",
      endpoint: GMAIL_MESSAGES,
      method: "GET",
    });

    expect(result).toMatchObject({ ok: false, code: "provider_error", status: 401 });
  });
});
