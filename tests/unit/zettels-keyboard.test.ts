import { describe, expect, it } from "vitest";
import { isCardNavKey, isFinalizeKey, suggestionKeyAction } from "@/components/polymath/zettels/keyboard";

describe("sitting keyboard map (§14.3, §14.13)", () => {
  it("plain Enter keeps and Escape discards while the suggestion is focused", () => {
    expect(suggestionKeyAction("Enter", true)).toBe("keep");
    expect(suggestionKeyAction("Escape", true)).toBe("discard");
  });
  it("suggestion keys do nothing when the suggestion is not focused", () => {
    expect(suggestionKeyAction("Enter", false)).toBeNull();
    expect(suggestionKeyAction("Escape", false)).toBeNull();
    expect(suggestionKeyAction("a", true)).toBeNull();
  });
  it("Cmd/Ctrl+Enter is finalize, not a substitute for Enter-keep", () => {
    expect(isFinalizeKey({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isFinalizeKey({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isFinalizeKey({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
  });
  it("Cmd+] / Cmd+[ navigate cards", () => {
    expect(isCardNavKey({ key: "]", metaKey: true, ctrlKey: false })).toBe("next");
    expect(isCardNavKey({ key: "[", metaKey: true, ctrlKey: false })).toBe("prev");
    expect(isCardNavKey({ key: "]", metaKey: false, ctrlKey: false })).toBeNull();
  });
});
