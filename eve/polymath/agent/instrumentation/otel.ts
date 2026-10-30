import { otel } from "eve/instrumentation/otel";

/*
 * Process-wide OpenTelemetry settings for Polymath's agents.
 *
 * Tracing-only: this file names what the destinations declared beside it share
 * (langfuse.ts is the one destination today). It exists so the content-capture
 * contract is explicit rather than implicit — the policy reproduces eve's
 * default rule exactly (inputs and outputs for development conversations,
 * metadata only for preview/production), so runtime behavior is unchanged.
 *
 * eve may invoke the policy more than once while a session is prepared, so it
 * must stay deterministic: it reads only the conversation environment.
 */
export default otel({
  tracePolicy: (trace) =>
    trace.environment === "development"
      ? { emit: true, recordInputs: true, recordOutputs: true }
      : { emit: true, recordInputs: false, recordOutputs: false },
});
