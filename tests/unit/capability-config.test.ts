import { describe, expect, it } from "vitest";
import { capabilityStatus, capabilitySummary } from "@/lib/capability-config";

/*
 * ASH-193. The bug this closes is a screen that renders an empty list when a
 * key is missing, which reads as "there is nothing here" rather than "this is
 * switched off". The unit under test is pure, so every case below is an
 * environment, not a mock.
 */

describe("capabilityStatus", () => {
  it("reports a capability missing when none of its variables are set, and names them", () => {
    const generation = capabilityStatus({}).find((c) => c.id === "generation")!;
    expect(generation.configured).toBe(false);
    expect(generation.missingEnv).toEqual(["OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]);
    expect(generation.reason).toContain("set OPENROUTER_API_KEY or GEMINI_API_KEY");
  });

  it("treats any one configured variable as sufficient", () => {
    const generation = capabilityStatus({ GEMINI_API_KEY: "k" }).find((c) => c.id === "generation")!;
    expect(generation.configured).toBe(true);
    expect(generation.missingEnv).toEqual([]);
    expect(generation.reason).toBe("");
  });

  it("treats a blank or whitespace variable as unset", () => {
    const storage = capabilityStatus({ BLOB_READ_WRITE_TOKEN: "   " }).find((c) => c.id === "private-file-storage")!;
    expect(storage.configured).toBe(false);
    expect(storage.missingEnv).toEqual(["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID"]);
  });

  it("never leaks a value, only the variable name", () => {
    const withSecret = capabilityStatus({ REDUCTO_API_KEY: "super-secret-value" });
    expect(JSON.stringify(withSecret)).not.toContain("super-secret-value");
  });

  it("splits ready from missing for the settings panel", () => {
    const { configured, missing } = capabilitySummary({ OPENROUTER_API_KEY: "k", COMPOSIO_API_KEY: "c" });
    expect(configured.map((c) => c.id)).toEqual(
      expect.arrayContaining(["generation", "embeddings", "calendar-sync", "email-send"]),
    );
    expect(missing.map((c) => c.id)).toEqual(expect.arrayContaining(["document-extraction-hosted", "private-file-storage"]));
    expect(configured.length + missing.length).toBe(8);
  });

  it("agrees with the extraction adapter's provider order", () => {
    // Mirrors src/domains/knowledge/extraction.ts: any one of these selects a
    // hosted reader; with none, the in-process text layer is the floor.
    const ids = capabilityStatus({ LLAMAPARSE_API_KEY: "k" }).find((c) => c.id === "document-extraction-hosted")!;
    expect(ids.configured).toBe(true);
  });
});
