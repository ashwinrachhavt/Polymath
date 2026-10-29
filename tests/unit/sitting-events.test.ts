import { describe, expect, it } from "vitest";
import {
  assertEventRedacted,
  DECOMPOSE_MAX_CHARS,
  DECOMPOSE_PASTE_CHARS,
  encodeSittingEvent,
  isAllowedStageOutcome,
  pasteDisposition,
  SITTING_EVENTS,
  SITTING_PROTOCOL_VERSION,
  type SittingEvent,
} from "@/domains/knowledge/sitting-events";

/*
 * §15.9: the event schema test embeds one example NDJSON frame per event
 * family, pins the §15.2 persistence allowlist, and asserts credentials never
 * appear in an event.
 */
const RUN = "3f6b0b6a-7a5a-4a5a-9a5a-6a5a4a3a2a1a";
const ARTIFACT = "1b6b0b6a-7a5a-4a5a-9a5a-6a5a4a3a2a1a";
const VERSION = "2b6b0b6a-7a5a-4a5a-9a5a-6a5a4a3a2a1a";

const EXAMPLES: Record<string, SittingEvent> = {
  card_saved: { protocolVersion: 1, operationId: RUN, artifactId: ARTIFACT, artifactVersionId: VERSION, event: "card_saved", payload: { outcome: "saved" } },
  token: { protocolVersion: 1, operationId: RUN, artifactId: ARTIFACT, artifactVersionId: VERSION, event: "token", payload: { content: "the load-bearing" } },
  thinking: { protocolVersion: 1, operationId: RUN, event: "thinking", payload: { content: "Reading your draft…" } },
  links_found: { protocolVersion: 1, operationId: RUN, artifactId: ARTIFACT, event: "links_found", payload: { outcome: "links:4", candidates: 4 } },
  enrichment: { protocolVersion: 1, operationId: RUN, artifactId: ARTIFACT, event: "enrichment", payload: { outcome: "enriched", title: "A note", tags: ["x", "y", "z"] } },
  bloom_suggested: { protocolVersion: 1, operationId: RUN, artifactId: ARTIFACT, event: "bloom_suggested", payload: { outcome: "bloom:2" } },
  stage_started: { protocolVersion: 1, operationId: RUN, event: "stage_started", payload: { stage: "embed" } },
  stage_completed: { protocolVersion: 1, operationId: RUN, event: "stage_completed", payload: { stage: "embed", outcome: "embedded:v3" } },
  stage_failed: { protocolVersion: 1, operationId: RUN, event: "stage_failed", payload: { stage: "links", code: "QUOTA_UNAVAILABLE", message: "Link discovery needs AI quota - your card is saved.", operationId: RUN } },
  warning: { protocolVersion: 1, operationId: RUN, event: "warning", payload: { message: "Embedding unavailable; indexing skipped." } },
  done: { protocolVersion: 1, operationId: RUN, artifactId: ARTIFACT, event: "done" },
  error: { protocolVersion: 1, operationId: RUN, event: "error", payload: { code: "RUN_FAILED", message: "The sitting run failed - your writing is saved." } },
};

describe("sitting event protocol (§15.9)", () => {
  it("embeds one example frame per event family, each an NDJSON line", () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual([...SITTING_EVENTS].sort());
    for (const event of Object.values(EXAMPLES)) {
      const line = encodeSittingEvent(event);
      expect(line.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(line);
      expect(parsed.protocolVersion).toBe(SITTING_PROTOCOL_VERSION);
      expect(parsed.operationId).toBe(RUN);
    }
  });

  it("pins the §15.2 stage-outcome allowlist - nothing outside it may persist", () => {
    for (const allowed of ["saved", "embedded:v3", "links:4", "links:0", "enriched", "bloom:1", "bloom:2", "bloom:3", "skipped:edited", "skipped:busy", "failed:embed", "failed:links"]) {
      expect(isAllowedStageOutcome(allowed), allowed).toBe(true);
    }
    for (const rejected of ["", "embedded", "embedded:3", "links", "bloom:4", "bloom:mastered", "failed", "skipped", "raw provider payload", "the load-bearing idea is…"]) {
      expect(isAllowedStageOutcome(rejected), rejected).toBe(false);
    }
  });

  it("carries the §15.2 stage_failed payload shape", () => {
    const payload = EXAMPLES.stage_failed.payload as { stage: string; code: string; message: string; operationId: string };
    expect(payload.stage).toBe("links");
    expect(payload.code).toBe("QUOTA_UNAVAILABLE");
    expect(typeof payload.message).toBe("string");
    expect(payload.operationId).toBe(RUN);
  });

  it("rejects an event carrying a credential marker (§15.9)", () => {
    for (const event of Object.values(EXAMPLES)) expect(() => assertEventRedacted(event)).not.toThrow();
    const leaky: SittingEvent = { protocolVersion: 1, operationId: RUN, event: "error", payload: { message: "CLOUDFLARE_API_KEY=abc failed" } };
    expect(() => assertEventRedacted(leaky)).toThrow(/credential marker/);
  });
});

describe("§4/§15.1 pasteDisposition", () => {
  it("rejects pastes over the cap - never truncate, never land", () => {
    expect(pasteDisposition(DECOMPOSE_MAX_CHARS + 1)).toBe("reject");
    expect(pasteDisposition(DECOMPOSE_MAX_CHARS * 2)).toBe("reject");
  });

  it("at the cap exactly still analyzes - the cap is exclusive", () => {
    expect(pasteDisposition(DECOMPOSE_MAX_CHARS)).toBe("analyze");
  });

  it("at or above the analysis threshold offers extraction review", () => {
    expect(pasteDisposition(DECOMPOSE_PASTE_CHARS)).toBe("analyze");
    expect(pasteDisposition(DECOMPOSE_PASTE_CHARS + 1)).toBe("analyze");
  });

  it("below the threshold is a plain paste", () => {
    expect(pasteDisposition(0)).toBe("plain");
    expect(pasteDisposition(DECOMPOSE_PASTE_CHARS - 1)).toBe("plain");
  });
});
