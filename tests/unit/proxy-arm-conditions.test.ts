import { afterEach, describe, expect, it, vi } from "vitest";

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = savedEnv;
});

describe("proxyArmed", () => {
  it("arms only when both Clerk keys are present, and the dev bypass disarms it outside production", async () => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.POLYMATH_DEV_AUTH;
    vi.resetModules();
    expect((await import("@/lib/clerk")).proxyArmed).toBe(false);

    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_proxy-armed";
    process.env.CLERK_SECRET_KEY = "sk_test_proxy-armed";
    vi.resetModules();
    expect((await import("@/lib/clerk")).proxyArmed).toBe(true);

    // vitest runs with NODE_ENV=test, so the bypass applies — same as local
    // e2e — and the proxy answers next() while next.config keeps the static
    // "/" redirect.
    process.env.POLYMATH_DEV_AUTH = "1";
    vi.resetModules();
    expect((await import("@/lib/clerk")).proxyArmed).toBe(false);
  });
});
