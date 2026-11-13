import { describe, expect, it } from "vitest";
import {
  MODEL_CATALOG,
  DEFAULT_MODEL_ID,
  ASSESSOR_MODEL_ID,
  availableModels,
  modelById,
  resolveModelId,
  resolveRunModel,
} from "@/domains/agents/models";

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

  it("declares mercury-voice on Inception's endpoint, hidden without the key", () => {
    // Reserved for latency-sensitive turns and a later-wave voice surface
    // (spec §9). Declared from Inception's models page as a listing entry —
    // the account's live /v1/models did not serve it on 2026-11-02, so the
    // probe says so and it must never become a default.
    const voice = modelById("mercury-voice");
    expect(voice).not.toBeNull();
    expect(voice!.provider).toBe("mercury");
    expect(voice!.baseUrl).toBe("https://api.inceptionlabs.ai/v1");
    expect(voice!.keyEnv).toBe("MERCURY_API_KEY");
    expect(availableModels({}).map((m) => m.id)).not.toContain("mercury-voice");
    expect(availableModels({ MERCURY_API_KEY: "m" }).map((m) => m.id)).toContain("mercury-voice");
  });

  it("keeps the chat picker free of the decisions-only model", () => {
    // mercury-decide answers POST /v1/decisions only — it does not serve
    // /chat/completions, so frozen into a chat run it would fail on the first
    // turn. The superagent decide module declares it (DECIDE_MODEL_ID).
    expect(modelById("mercury-decide")).toBeNull();
  });

  it("names mercury-3 the assessor default and resolves it through the catalog", () => {
    expect(ASSESSOR_MODEL_ID).toBe("mercury-3");
    expect(modelById(ASSESSOR_MODEL_ID)?.provider).toBe("mercury");
  });

  it("sends a DeepSeek id only to the base URL that serves it", () => {
    // The same id is served by more than one gateway; an entry that pairs one
    // gateway's id with another's base URL fails with "not a valid model ID".
    for (const model of MODEL_CATALOG.filter((m) => m.id.startsWith("deepseek/"))) {
      expect(model.baseUrl, model.id).toMatch(/^https:\/\//);
      // DeepSeek ids differ per gateway; an id paired with the wrong base URL
      // fails with "not a valid model ID", so the mapping is asserted, not assumed.
      if (model.provider === "openrouter") expect(model.baseUrl, model.id).toBe("https://openrouter.ai/api/v1");
      if (model.provider === "nvidia") expect(model.baseUrl, model.id).toBe("https://integrate.api.nvidia.com/v1");
    }
  });
});

describe("resolveRunModel", () => {
  it("resolves the profile's pinned primary when it names a catalog entry", () => {
    const pinned = MODEL_CATALOG.find((m) => m.id !== DEFAULT_MODEL_ID) ?? MODEL_CATALOG[0];
    expect(resolveRunModel({ primary: pinned.id })?.id).toBe(pinned.id);
  });

  it("falls back to the catalog default for a missing, non-object, or unknown pin", () => {
    for (const policy of [null, undefined, "gemini-3.5-flash-lite", 42, {}, { primary: "claude-hive-gone" }]) {
      expect(resolveRunModel(policy)?.id, JSON.stringify(policy)).toBe(DEFAULT_MODEL_ID);
    }
  });
});
