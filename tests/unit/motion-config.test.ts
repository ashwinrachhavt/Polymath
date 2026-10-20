import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { motionTransition } from "@/components/motion-config";

describe("motion transition token", () => {
  it("is a finite, non-negative duration short enough not to delay work", () => {
    expect(Number.isFinite(motionTransition.duration)).toBe(true);
    expect(motionTransition.duration).toBeGreaterThanOrEqual(0);
    expect(motionTransition.duration).toBeLessThanOrEqual(0.2);
  });

  it("uses a well-formed cubic-bezier easing", () => {
    const ease = motionTransition.ease;
    expect(ease).toHaveLength(4);
    expect(ease[0]).toBeGreaterThanOrEqual(0);
    expect(ease[0]).toBeLessThanOrEqual(1);
    expect(ease[2]).toBeGreaterThanOrEqual(0);
    expect(ease[2]).toBeLessThanOrEqual(1);
    for (const control of ease) expect(Number.isFinite(control)).toBe(true);
  });
});

/*
 * The provider's whole job is passing `reducedMotion="user"` to MotionConfig;
 * asserting it on the rendered tree would need a DOM renderer, so the source is
 * the contract under test.
 */
describe("MotionProvider", () => {
  it('declares reducedMotion="user"', () => {
    const source = readFileSync("src/components/motion-config.tsx", "utf8");
    expect(source).toContain("<MotionConfig reducedMotion=\"user\">");
  });
});
