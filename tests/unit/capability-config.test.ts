import { describe, expect, it } from "vitest";
import { capabilityStatus, capabilitySummary } from "@/lib/capability-config";

/*
 * ASH-193. The bug this closes is a screen that renders an empty list when a
 * key is missing, which reads as "nothing here" rather than "this is switched
 * off". Each case below is an environment, not a mock — the module is pure.
 *
 * The cases that matter most are the ones where a naive "any key is set" check
 * would report ready while the adapter throws: a selector pointing at a
 * provider whose key is missing, and a bridge secret too short to sign with.
 * A panel that lies in exactly those states is worse than no panel.
 */

const find = (env: Record<string, string | undefined>, id: string) =>
  capabilityStatus(env).find((c) => c.id === id)!;

describe("capabilityStatus", () => {
  it("reports a capability missing when none of its variables are set, and names them", () => {
    const generation = find({}, "generation");
    expect(generation.configured).toBe(false);
    expect(generation.missingEnv).toEqual(["MERCURY_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]);
    expect(generation.reason).toContain("set MERCURY_API_KEY, GEMINI_API_KEY or OPENROUTER_API_KEY");
  });

  it("treats any one configured variable as sufficient when no selector is set", () => {
    const generation = find({ GEMINI_API_KEY: "k" }, "generation");
    expect(generation.configured).toBe(true);
    expect(generation.missingEnv).toEqual([]);
    expect(generation.reason).toBe("");
  });

  it("treats a blank or whitespace variable as unset", () => {
    const storage = find({ BLOB_READ_WRITE_TOKEN: "   ", NODE_ENV: "production" }, "private-file-storage");
    expect(storage.configured).toBe(false);
    expect(storage.missingEnv).toEqual(["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID"]);
  });

  it("never leaks a value, only the variable name", () => {
    expect(JSON.stringify(capabilityStatus({ REDUCTO_API_KEY: "super-secret-value" }))).not.toContain(
      "super-secret-value",
    );
  });

  describe("selector variables model the resolver, not a set of keys", () => {
    it("SEARCH_PROVIDER=firecrawl without its key is not ready", () => {
      const search = find({ SEARCH_PROVIDER: "firecrawl" }, "web-search-keyed");
      expect(search.configured).toBe(false);
      expect(search.missingEnv).toEqual(["FIRECRAWL_HOSTED_API_KEY"]);
    });

    it("SEARCH_PROVIDER=firecrawl with its key is ready even when another provider key is absent", () => {
      expect(find({ SEARCH_PROVIDER: "firecrawl", FIRECRAWL_HOSTED_API_KEY: "k" }, "web-search-keyed").configured).toBe(true);
    });

    it("an unknown selector is never ready", () => {
      const search = find({ SEARCH_PROVIDER: "nonsense", BRAVE_SEARCH_API_KEY: "k" }, "web-search-keyed");
      expect(search.configured).toBe(false);
      expect(search.missingEnv[0]).toContain("not a known choice");
    });

    it("GENERATION_PROVIDER=gemini with only an OpenRouter key is not ready", () => {
      const generation = find({ GENERATION_PROVIDER: "gemini", OPENROUTER_API_KEY: "k" }, "generation");
      expect(generation.configured).toBe(false);
      expect(generation.missingEnv).toEqual(["GEMINI_API_KEY"]);
    });

    it("EMBEDDING_PROVIDER=openai with only an OpenRouter key is not ready", () => {
      expect(find({ EMBEDDING_PROVIDER: "openai", OPENROUTER_API_KEY: "k" }, "embeddings").configured).toBe(false);
    });
  });

  describe("agent execution requires a usable secret, not a URL", () => {
    it("EVE_BASE_URL alone is not ready", () => {
      const agents = find({ EVE_BASE_URL: "https://eve.example" }, "agent-execution");
      expect(agents.configured).toBe(false);
      expect(agents.missingEnv).toContain("EVE_BRIDGE_SECRET");
    });

    it("a bridge secret under 32 characters is not ready", () => {
      const agents = find({ EVE_BRIDGE_SECRET: "too-short" }, "agent-execution");
      expect(agents.configured).toBe(false);
      expect(agents.missingEnv[0]).toContain("32 characters");
    });

    it("a 32-character bridge secret is ready without a base URL, because a deployment reaches its own origin", () => {
      expect(find({ EVE_BRIDGE_SECRET: "x".repeat(32) }, "agent-execution").configured).toBe(true);
    });
  });

  it("email sending is ready only with the Composio key the Gmail adapter needs", () => {
    const missing = find({}, "email-send");
    expect(missing.configured).toBe(false);
    expect(missing.missingEnv).toContain("COMPOSIO_API_KEY");
    expect(missing.reason).toContain("connect a Gmail account");
    expect(find({ COMPOSIO_API_KEY: "k" }, "email-send").configured).toBe(true);
  });

  it("local development has working file storage without a cloud key", () => {
    expect(find({ NODE_ENV: "development" }, "private-file-storage").configured).toBe(true);
    expect(find({ NODE_ENV: "production" }, "private-file-storage").configured).toBe(false);
  });

  it("splits ready from missing for the settings panel", () => {
    const { configured, missing } = capabilitySummary({ OPENROUTER_API_KEY: "k", COMPOSIO_API_KEY: "c" });
    expect(configured.map((c) => c.id)).toEqual(
      expect.arrayContaining(["generation", "embeddings", "calendar-sync", "email-send"]),
    );
    expect(missing.map((c) => c.id)).toEqual(expect.arrayContaining(["document-extraction-hosted"]));
    expect(configured.length + missing.length).toBe(8);
  });

  it("agrees with the extraction adapter's provider order", () => {
    // Mirrors src/domains/knowledge/extraction.ts: any one of these selects a
    // hosted reader; with none, the in-process text layer is the floor.
    expect(find({ LLAMAPARSE_API_KEY: "k" }, "document-extraction-hosted").configured).toBe(true);
    expect(find({}, "document-extraction-hosted").configured).toBe(false);
  });

  describe("vision OCR is opt-in, never inferred from a key's presence", () => {
    it("an OpenRouter key alone does not configure scan reading", () => {
      expect(find({ OPENROUTER_API_KEY: "k" }, "document-extraction-hosted").configured).toBe(false);
    });

    it("OCR_PROVIDER=openrouter with the key is configured", () => {
      const cap = find({ OCR_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" }, "document-extraction-hosted");
      expect(cap.configured).toBe(true);
      expect(cap.missingEnv).toEqual([]);
    });

    it("OCR_PROVIDER=openrouter without the key names the key, not the menu", () => {
      const cap = find({ OCR_PROVIDER: "openrouter" }, "document-extraction-hosted");
      expect(cap.configured).toBe(false);
      expect(cap.missingEnv).toEqual(["OPENROUTER_API_KEY"]);
    });

    it("off by default: the enable path is named with its metered shape", () => {
      const cap = find({}, "document-extraction-hosted");
      expect(cap.configured).toBe(false);
      expect(cap.reason).toContain("OCR_PROVIDER=openrouter");
      expect(cap.reason).toContain("metered");
    });
  });
});
