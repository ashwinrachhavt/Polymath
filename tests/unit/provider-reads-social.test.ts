import { describe, expect, it } from "vitest";
import { getInstagramProfile, listInstagramMedia } from "@/domains/integrations/reads/instagram";
import { getLinkedInProfile } from "@/domains/integrations/reads/linkedin";
import { CAPABILITIES, PROVIDER_TOOLS } from "@/domains/integrations/capabilities";
import { TOOL_SCHEMAS } from "@/domains/integrations/tool-manifest";
import { fixtureTransport } from "../helpers/fixture-transport";

const ACCOUNT = "ca_test";

describe("linkedin reads", () => {
  it("reads the member profile through OpenID userinfo", async () => {
    const captured: import("@/domains/integrations/transport").TransportRequest[] = [];
    const transport = fixtureTransport(
      [
        {
          method: "GET",
          endpointPrefix: "https://api.linkedin.com/v2/userinfo",
          status: 200,
          body: { sub: "abc123", name: "Ashwin Rachha", given_name: "Ashwin", family_name: "Rachha", picture: "https://pic", email: "a@b.c" },
        },
      ],
      captured,
    );
    const result = await getLinkedInProfile(transport, { connectedAccountId: ACCOUNT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toMatchObject({ id: "abc123", name: "Ashwin Rachha", email: "a@b.c" });
    // The request shape is fixed: one GET, no caller-influenced endpoint or body.
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("GET");
    expect(captured[0].endpoint).toBe("https://api.linkedin.com/v2/userinfo");
    expect(captured[0].connectedAccountId).toBe(ACCOUNT);
  });

  it("fails closed on a malformed profile body", async () => {
    const transport = fixtureTransport([{ method: "GET", endpointPrefix: "https://api.linkedin.com/v2/userinfo", status: 200, body: { unexpected: true } }]);
    const result = await getLinkedInProfile(transport, { connectedAccountId: ACCOUNT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("malformed_response");
  });

  it("surfaces a provider failure", async () => {
    const transport = fixtureTransport([{ method: "GET", endpointPrefix: "https://api.linkedin.com/v2/userinfo", status: 401, body: {} }]);
    const result = await getLinkedInProfile(transport, { connectedAccountId: ACCOUNT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("provider_error");
  });
});

describe("instagram reads", () => {
  it("reads the professional account profile", async () => {
    const captured: import("@/domains/integrations/transport").TransportRequest[] = [];
    const transport = fixtureTransport(
      [
        {
          method: "GET",
          endpointPrefix: "https://graph.instagram.com/me",
          status: 200,
          body: { id: "ig1", username: "ashwin", account_type: "BUSINESS", media_count: 42 },
        },
      ],
      captured,
    );
    const result = await getInstagramProfile(transport, { connectedAccountId: ACCOUNT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toMatchObject({ id: "ig1", username: "ashwin", accountType: "BUSINESS", mediaCount: 42 });
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("GET");
    expect(captured[0].endpoint).toBe("https://graph.instagram.com/me");
    expect(captured[0].connectedAccountId).toBe(ACCOUNT);
  });

  it("lists recent media newest-first and clips captions", async () => {
    const longCaption = "x".repeat(500);
    const transport = fixtureTransport([
      {
        method: "GET",
        endpointPrefix: "https://graph.instagram.com/me/media",
        status: 200,
        body: {
          data: [
            { id: "m1", caption: longCaption, media_type: "IMAGE", permalink: "https://ig/p/m1", timestamp: "2026-10-22T00:00:00Z" },
            { id: "m2", media_type: "VIDEO", permalink: "https://ig/p/m2", timestamp: "2026-10-21T00:00:00Z" },
          ],
        },
      },
    ]);
    const result = await listInstagramMedia(transport, { connectedAccountId: ACCOUNT, limit: 25 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(2);
    expect(result.items[0].caption).toHaveLength(281);
    expect(result.items[1].caption).toBeNull();
  });

  it("fails closed on a malformed media body", async () => {
    const transport = fixtureTransport([{ method: "GET", endpointPrefix: "https://graph.instagram.com/me/media", status: 200, body: 42 }]);
    const result = await listInstagramMedia(transport, { connectedAccountId: ACCOUNT, limit: 25 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("malformed_response");
  });

  it("surfaces a provider failure (personal account, expired token)", async () => {
    const transport = fixtureTransport([{ method: "GET", endpointPrefix: "https://graph.instagram.com/me/media", status: 400, body: {} }]);
    const result = await listInstagramMedia(transport, { connectedAccountId: ACCOUNT, limit: 25 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("provider_error");
  });
});

describe("social capability wiring", () => {
  it("every social tool maps to a read capability with a schema", () => {
    for (const tool of ["linkedin_get_profile", "instagram_get_profile", "instagram_list_media"] as const) {
      const capability = PROVIDER_TOOLS[tool];
      expect(capability, tool).toBeDefined();
      expect(CAPABILITIES[capability].kind).toBe("read");
      expect(CAPABILITIES[capability].riskClass).toBe("read");
      expect(TOOL_SCHEMAS[tool]).toBeDefined();
    }
  });

  it("no social capability carries a write or effect risk", () => {
    for (const [id, spec] of Object.entries(CAPABILITIES)) {
      if (spec.provider === "linkedin" || spec.provider === "instagram") {
        expect(spec.riskClass, id).toBe("read");
      }
    }
  });
});
