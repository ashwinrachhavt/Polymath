import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The laptop and CI run with no DSN and must behave as if Sentry were not
 * installed: no init, so no client and nothing sent. With a DSN, each runtime
 * initialises once with the shared options. The SDK is mocked; what is under
 * test is the decision each instrumentation entry makes from the environment.
 */
const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  init,
  captureRequestError: vi.fn(),
  captureRouterTransitionStart: vi.fn(),
}));

const DSN = "https://public@o0.ingest.sentry.io/0";

beforeEach(() => {
  init.mockClear();
  vi.resetModules();
  vi.stubEnv("SENTRY_DSN", "");
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("server instrumentation register()", () => {
  it("does not initialise Sentry without a DSN", async () => {
    const { register } = await import("@/instrumentation");
    register();
    expect(init).not.toHaveBeenCalled();
  });

  it("prefers SENTRY_DSN and falls back to the public DSN", async () => {
    const { register } = await import("@/instrumentation");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
    register();
    expect(init).toHaveBeenLastCalledWith(expect.objectContaining({ dsn: DSN }));

    vi.stubEnv("SENTRY_DSN", "https://server@o0.ingest.sentry.io/1");
    register();
    expect(init).toHaveBeenLastCalledWith(expect.objectContaining({ dsn: "https://server@o0.ingest.sentry.io/1" }));
  });
});

describe("client instrumentation", () => {
  it("does not initialise Sentry or hook navigations without a DSN", async () => {
    const client = await import("@/instrumentation-client");
    expect(init).not.toHaveBeenCalled();
    expect(client.onRouterTransitionStart).toBeUndefined();
  });

  it("initialises once and hooks navigations with a DSN", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
    const client = await import("@/instrumentation-client");
    expect(init).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ dsn: DSN }));
    expect(client.onRouterTransitionStart).toBeTypeOf("function");
  });
});
