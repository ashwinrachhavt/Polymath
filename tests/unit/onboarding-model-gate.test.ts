import { beforeEach, describe, expect, it, vi } from "vitest";
import { interviewModelGate } from "@/app/(workspace)/onboarding/model-gate";
import { DEFAULT_MODEL_ID, modelById } from "@/domains/agents/models";
import { AllowanceExhaustedError, ModelUnavailableError, houseRoute } from "@/domains/billing/resolver";

/*
 * The F7 gate: the start action must learn that no model can serve the
 * workspace before any run row, session or reservation exists, and must name
 * the reason. The decision belongs to the billing resolver (own key, house key
 * under the allowance, neither); the gate only translates its outcomes. The
 * resolver is stubbed here so the unit needs no database; billing.test.ts
 * proves the resolver itself.
 *
 * Value: protects=the keyless or out-of-allowance start landing on the labelled
 * error card with the form fallback; fails_when=the gate blocks a servable
 * model, resolves a pinned model differently from the runtime, or hides the
 * allowance message; seam=the real catalog and houseRoute with a stubbed
 * resolver; no_claim=that the runtime is reachable.
 */

const resolve = vi.fn();
vi.mock("@/domains/billing/resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domains/billing/resolver")>()),
  resolveModelRoute: (...args: unknown[]) => resolve(...args),
}));

const DEFAULT_KEY_ENV = modelById(DEFAULT_MODEL_ID)!.keyEnv;

beforeEach(() => {
  resolve.mockReset();
});

describe("interviewModelGate", () => {
  it("passes when the resolver serves the default model", async () => {
    resolve.mockResolvedValue(houseRoute(DEFAULT_MODEL_ID, { [DEFAULT_KEY_ENV]: "k" }));
    expect((await interviewModelGate("ws", null)).ok).toBe(true);
    expect(resolve).toHaveBeenCalledWith("ws", DEFAULT_MODEL_ID, "chat");
  });

  it("asks about the pinned model, and about the default for an unrecognized pin", async () => {
    resolve.mockResolvedValue({});
    await interviewModelGate("ws", { primary: "mercury-3" });
    expect(resolve).toHaveBeenLastCalledWith("ws", "mercury-3", "chat");
    await interviewModelGate("ws", { primary: "not-a-real-model" });
    expect(resolve).toHaveBeenLastCalledWith("ws", DEFAULT_MODEL_ID, "chat");
    await interviewModelGate("ws", { primary: 42 });
    expect(resolve).toHaveBeenLastCalledWith("ws", DEFAULT_MODEL_ID, "chat");
  });

  it("names the missing house key and offers the form", async () => {
    resolve.mockImplementation(async () => houseRoute(DEFAULT_MODEL_ID, {}));
    const gate = await interviewModelGate("ws", null);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.message).toContain(DEFAULT_KEY_ENV);
      expect(gate.message).toContain("Answer as a form instead");
    }
  });

  it("says the allowance is used up and what to do", async () => {
    resolve.mockImplementation(async () => {
      throw new AllowanceExhaustedError("free", 100);
    });
    const gate = await interviewModelGate("ws", null);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.message).toContain("Add your own key");
      expect(gate.message).toContain("upgrade to Pro");
    }
  });

  it("does not swallow an unexpected failure", async () => {
    resolve.mockImplementation(async () => {
      throw new Error("db down");
    });
    await expect(interviewModelGate("ws", null)).rejects.toThrow("db down");
    expect(new ModelUnavailableError("x")).toBeInstanceOf(Error);
  });
});
