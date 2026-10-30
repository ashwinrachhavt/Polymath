import { defineLangfuseInstrumentation } from "@vantezzen/langfuse-eve/instrumentation";

/*
 * Langfuse trace destination for Polymath's agents (self-hosted Langfuse v4).
 *
 * Tracing-only, by design: this never imports `@vantezzen/langfuse-eve/instructions`
 * or `/skills` — those subpaths would move the agent's prompt source of truth
 * from the repo into Langfuse, a behavior change. The agent's instructions and
 * skills stay exactly where they are.
 *
 * Credentials come from the environment (`LANGFUSE_PUBLIC_KEY`,
 * `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`), read by the Langfuse span
 * processor itself; the `langfuse` option here could pass them explicitly, but
 * env keeps the agent bundle free of configuration. With no credentials
 * configured, the processor logs non-fatal warnings and nothing exports.
 * Traces correlate with the app's `agent_runs.session_ref` (the eve session
 * id), which the eval verification runner joins on.
 *
 * v4 ingestion (`x-langfuse-ingestion-version: 4`): the local stack ships
 * Langfuse v4 images, and `@langfuse/otel` does not send the ingestion-version
 * header itself — its exporter sends Authorization plus `x-langfuse-sdk-*` /
 * `x-langfuse-public-key` headers and only then spreads
 * `additionalHeaders` from `LangfuseSpanProcessorParams`. Without the header,
 * the v4 server interprets spans under the legacy ingestion model and rewrites
 * them (degraded attribution). The header is set explicitly here.
 *
 * The rest of the v4 ingestion contract is covered by the wrapper's existing
 * span pipeline, verified against its installed source (`instrumentation-DQdwTyrh.js`):
 * spans arrive complete (enrichment composes attributes at `onEnd` without
 * touching timing/status); session and user propagate per observation because
 * the runtime-context projection is mapped to `session.id` / `user.id` span
 * attributes at span start, and root-observation input/output follow from the
 * explicit development-audience trace policy declared in `otel.ts`. What this
 * file does not and cannot claim is live wire behavior against a running v4
 * server — that evidence belongs to the verification runner's AC7 smoke.
 *
 * The integration package declares peer `eve ^0.55.0` (its pre-slot API era);
 * source-level compatibility with eve 0.76.3's
 * `otelIntegration({ runtimeContext, spanProcessors })` was verified, and the
 * root package.json `peerDependencyRules.allowedVersions` entry records the
 * deliberate override. If the alpha package misbehaves, the fallback is the
 * official `LangfuseSpanProcessor` wired into `otelIntegration()` in this same
 * file shape — with the same `additionalHeaders` entry, which comes from
 * `@langfuse/otel` itself, not from the wrapper.
 */
export default defineLangfuseInstrumentation({
  langfuse: {
    additionalHeaders: {
      "x-langfuse-ingestion-version": "4",
    },
  },
});
