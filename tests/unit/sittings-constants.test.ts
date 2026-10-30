import { describe, expect, it } from "vitest";
import {
  artifactWorkspaceMismatch,
  CREATION_IDLE_MS,
  DECOMPOSE_MAX_CHARS,
  DECOMPOSE_PASTE_CHARS,
  SittingError,
} from "@/domains/knowledge/sittings";
import * as sittingsModule from "@/domains/knowledge/sittings";

/*
 * §15.1: both constants live as named module exports with the exact settled
 * values; §15.4/§15.8: the typed error payloads are contracts the client
 * renders verbatim.
 */
describe("sitting constants (§15.1)", () => {
  it("pins the creation idle debounce (§14.2)", () => {
    expect(CREATION_IDLE_MS).toBe(1200);
  });
  it("pins the decomposition paste bounds - reject, never truncate", () => {
    expect(DECOMPOSE_PASTE_CHARS).toBe(2000);
    expect(DECOMPOSE_MAX_CHARS).toBe(20000);
    expect(DECOMPOSE_MAX_CHARS).toBeGreaterThan(DECOMPOSE_PASTE_CHARS);
  });
});

describe("sitting typed errors", () => {
  it("carries the §15.4 foreign-workspace payload", () => {
    const err = artifactWorkspaceMismatch();
    expect(err).toBeInstanceOf(SittingError);
    expect(err.code).toBe("ARTIFACT_WORKSPACE_MISMATCH");
    expect(err.message).toBe("That card belongs to another workspace.");
  });
});

describe("no sitting lifecycle (Gate 2026-10-29)", () => {
  it("exposes no end action and no SITTING_ENDED error", () => {
    expect("endSitting" in sittingsModule).toBe(false);
    expect("sittingEnded" in sittingsModule).toBe(false);
  });
});
