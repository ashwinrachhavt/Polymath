import { describe, expect, it } from "vitest";
import { interviewModelGate } from "@/app/(workspace)/onboarding/model-gate";

/*
 * The F7 gate: the start action must detect an unconfigured provider key
 * before any run row, session, or spend reservation exists, and name the
 * missing key in its failure. The resolution here must mirror the runtime's
 * (profile-pinned primary, else the catalog default) — otherwise the gate
 * passes a run the runtime will kill mid-conversation, or blocks a run the
 * runtime would have served.
 *
 * Value: protects=the keyless/broken-key start landing on the labelled error
 * card (with the form fallback) instead of a mid-conversation death;
 * fails_when=the gate fires on a configured key, misses the exact env var
 * name the runtime reads, or resolves a pinned model differently from the
 * runtime; seam=the models catalog (real) with env passed explicitly;
 * no_claim=that the runtime itself is reachable — the bridge check handles
 * that before this gate runs.
 */

const KEYED = { GEMINI_API_KEY: "test-key" } as Record<string, string | undefined>;

describe("interviewModelGate", () => {
  it("blocks when the default model's key is absent", () => {
    const gate = interviewModelGate(null, {});
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.message).toContain("GEMINI_API_KEY");
  });

  it("passes when the default model's key is present", () => {
    expect(interviewModelGate(null, KEYED).ok).toBe(true);
  });

  it("blocks on the pinned model's own key, not the default's", () => {
    const gate = interviewModelGate({ primary: "mercury-3" }, {});
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.message).toContain("MERCURY_API_KEY");
  });

  it("passes when the pinned model's key is present", () => {
    const env = { ...KEYED, MERCURY_API_KEY: "test-key" };
    expect(interviewModelGate({ primary: "mercury-3" }, env).ok).toBe(true);
  });

  it("resolves an unrecognized pin to the default's key, mirroring the runtime", () => {
    const gate = interviewModelGate({ primary: "not-a-real-model" }, {});
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.message).toContain("GEMINI_API_KEY");
  });

  it("treats a whitespace-only key as absent", () => {
    const gate = interviewModelGate(null, { GEMINI_API_KEY: "   " });
    expect(gate.ok).toBe(false);
  });

  it("ignores a non-string primary instead of crashing", () => {
    const gate = interviewModelGate({ primary: 42 }, KEYED);
    expect(gate.ok).toBe(true);
  });

  it("names the form fallback in the failure message", () => {
    const gate = interviewModelGate(null, {});
    if (!gate.ok) expect(gate.message).toContain("form");
  });
});
