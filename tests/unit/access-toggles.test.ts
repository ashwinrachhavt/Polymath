import { describe, expect, it } from "vitest";
import { accessToggleState } from "@/domains/integrations/access-toggles";

/*
 * The two-switch mapping is the owner-facing contract over the tier catalog:
 * these tests are the spec the component and the enforcement model must agree
 * on. The tier stays the ceiling; a switch can only narrow it.
 */
describe("accessToggleState", () => {
  it("gmail read+send tier shows both switches on", () => {
    const s = accessToggleState("gmail", "read_send", []);
    expect(s.read).toEqual({ available: true, on: true });
    expect(s.write).toEqual({ available: true, on: true, label: "Send" });
  });

  it("a switched-off read capability shows read off", () => {
    const s = accessToggleState("gmail", "read_send", ["gmail.read"]);
    expect(s.read.on).toBe(false);
  });

  it("a read-only provider has no write switch", () => {
    const s = accessToggleState("slack", "read_only", []);
    expect(s.write).toBeNull();
    expect(s.read.on).toBe(true);
  });

  it("an unknown tier reads as read-off, write-off", () => {
    const s = accessToggleState("gmail", null, []);
    expect(s.read.on).toBe(false);
    expect(s.write?.on ?? false).toBe(false);
  });
});
