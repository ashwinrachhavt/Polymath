import { defineLangfuseInstrumentation } from "@vantezzen/langfuse-eve/instrumentation";

/*
 * Langfuse trace destination for Polymath's agents (self-hosted Langfuse v3).
 *
 * Tracing-only, by design: this never imports `@vantezzen/langfuse-eve/instructions`
 * or `/skills` — those subpaths would move the agent's prompt source of truth
 * from the repo into Langfuse, a behavior change. The agent's instructions and
 * skills stay exactly where they are.
 *
 * Credentials come from the environment (`LANGFUSE_PUBLIC_KEY`,
 * `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`), read by the Langfuse span
 * processor itself; the `langfuse` option here could pass them explicitly, but
 * env keeps the agent bundle free of configuration. Traces correlate with the
 * app's `agent_runs.session_ref` (the eve session id), which the eval
 * verification runner joins on.
 *
 * The integration package declares peer `eve ^0.55.0` (its pre-slot API era);
 * source-level compatibility with eve 0.76.3's
 * `otelIntegration({ runtimeContext, spanProcessors })` was verified, and the
 * root package.json `peerDependencyRules.allowedVersions` entry records the
 * deliberate override. If the alpha package misbehaves, the fallback is the
 * official `LangfuseSpanProcessor` wired into `otelIntegration()` in this same
 * file shape.
 */
export default defineLangfuseInstrumentation();
