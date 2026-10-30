import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, availableModels, modelById, resolveModelId } from "@/domains/agents/models";

/*
 * The catalog is the contract between the picker, the spend row, and the
 * executing agent: every entry must be internally consistent, and the default
 * must always resolve. These checks run without a network — a live probe is a
 * separate, deliberate act.
 */

describe("model catalog invariants", () => {
  it("has unique ids", () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses https OpenAI-compatible base URLs", () => {
    for (const model of MODEL_CATALOG) {
      expect(model.baseUrl, model.id).toMatch(/^https:\/\//);
      expect(model.keyEnv, model.id).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it("resolves the default model even when no keys are set", () => {
    expect(availableModels({})).toEqual([]);
    expect(modelById(resolveModelId(undefined))).not.toBeNull();
  });

  it("shows an entry when its key is set", () => {
    const [entry] = MODEL_CATALOG;
    expect(availableModels({ [entry.keyEnv]: "k" }).map((m) => m.id)).toContain(entry.id);
  });

  it("maps a retired model id to the default, not a dead id", () => {
    expect(resolveModelId("claude-hive-gone")).toBe(resolveModelId(undefined));
  });

  it("offers Mercury when its key is set, on Inception's endpoint", () => {
    // 100M-token trial grant (owner decision 2026-10-29). The picker entry is
    // separate from the generation seam's catalog; both must point at the same
    // OpenAI-compatible base URL.
    const mercury = modelById("mercury-3");
    expect(mercury).not.toBeNull();
    expect(mercury!.baseUrl).toBe("https://api.inceptionlabs.ai/v1");
    expect(mercury!.keyEnv).toBe("MERCURY_API_KEY");
    expect(availableModels({ MERCURY_API_KEY: "m" }).map((m) => m.id)).toContain("mercury-3");
    expect(availableModels({}).map((m) => m.id)).not.toContain("mercury-3");
  });

  it("sends a DeepSeek id only to the base URL that serves it", () => {    // The same id is served by more than one gateway; an entry that pairs one
    // gateway's id with another's base URL fails with "not a valid model ID".
    for (const model of MODEL_CATALOG.filter((m) => m.id.startsWith("deepseek/"))) {
      expect(model.baseUrl, model.id).toMatch(/^https:\/\//);
      // DeepSeek ids differ per gateway; an id paired with the wrong base URL
      // fails with "not a valid model ID", so the mapping is asserted, not assumed.
      if (model.provider === "openrouter-free") expect(model.baseUrl, model.id).toBe("https://openrouter.ai/api/v1");
      if (model.provider === "nvidia") expect(model.baseUrl, model.id).toBe("https://integrate.api.nvidia.com/v1");
    }
  });
});
