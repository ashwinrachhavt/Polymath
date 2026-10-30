import { describe, expect, it, vi } from "vitest";
import { TestNetworkViolation } from "../helpers/fetch-guard";

/*
 * The ui project renders components in jsdom; the fetch guard is installed
 * there too, and this file proves that wiring the same way the db project's
 * tests/integration/fetch-guard.test.ts proves its own. jsdom does not define
 * Request, so inputs stay strings; hosts use the reserved `.test` TLD so even
 * a missing guard leaks nothing.
 */
describe("fetch guard is armed in the ui project", () => {
  it("rejects an external fetch on globalThis", async () => {
    await expect(globalThis.fetch("https://payments.evil.test/v1/x")).rejects.toThrow(TestNetworkViolation);
  });

  it("lets an explicit double serve, and restoring it re-arms the guard", async () => {
    const double = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", double);
    try {
      const response = await globalThis.fetch("https://payments.evil.test/v1/x");
      expect(response.status).toBe(200);
      expect(double).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
    await expect(globalThis.fetch("https://payments.evil.test/v1/x")).rejects.toThrow(TestNetworkViolation);
  });
});
