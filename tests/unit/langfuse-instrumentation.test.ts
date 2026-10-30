import { describe, expect, it, vi } from "vitest";
import instrumentation from "../../eve/polymath/agent/instrumentation/langfuse";

const captured = vi.hoisted(() => ({
  options: [] as unknown[],
  integration: {} as Record<string, unknown>,
}));

// Mock the wrapper at the boundary this file owns: what the instrumentation
// module forwards into `defineLangfuseInstrumentation`. The wrapper's own
// forwarding chain (options.langfuse → LangfuseSpanProcessor → exporter
// headers) and its span pipeline are source-verified upstream behavior, not
// this file's contract — and its `runtimeContext` resolver throws outside an
// active eve runtime context, so it cannot run under vitest. Referencing the
// default export in the test is load-bearing: an unreferenced import is
// tree-shaken away and the module under test never evaluates.
vi.mock("@vantezzen/langfuse-eve/instrumentation", () => ({
  defineLangfuseInstrumentation: (options: unknown) => {
    captured.options.push(options);
    captured.integration = { runtimeContext: () => undefined, spanProcessors: [] };
    return captured.integration;
  },
}));

describe("langfuse instrumentation (v4 ingestion)", () => {
  it("forwards the v4 ingestion header through the wrapper's langfuse options, exactly once", () => {
    // @langfuse/otel's exporter spreads params.additionalHeaders over its own
    // Authorization/x-langfuse-* headers and never sets the ingestion version
    // itself — without this entry the v4 server reads spans as legacy model.
    // Exact-shape assertion also guards against reintroducing options eve's
    // compiler rejects (recordInputs/recordOutputs on the integration).
    expect(captured.options).toEqual([
      {
        langfuse: {
          additionalHeaders: { "x-langfuse-ingestion-version": "4" },
        },
      },
    ]);
    expect(instrumentation).toBe(captured.integration);
  });
});
