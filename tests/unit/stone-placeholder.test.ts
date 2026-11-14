import { describe, expect, it } from "vitest";
import { placeholderTint } from "@/components/stones/stone-placeholder";

describe("stone placeholder tint", () => {
  it("takes the first color word the catalog names", () => {
    expect(placeholderTint("Pale to deep purple")).toBe(placeholderTint("violet"));
    expect(placeholderTint("Green with blue flashes")).toBe(placeholderTint("green"));
    expect(placeholderTint("Blue-green")).toBe(placeholderTint("blue"));
  });

  it("falls back to a neutral grey for a color it cannot name", () => {
    expect(placeholderTint("Iridescent play-of-color")).toBe("oklch(0.7 0.02 270)");
  });
});
