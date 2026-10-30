const ALLOWED = new Set([
  "GEMINI_API_KEY", "GEMINI_AGENT_MODEL", "OPENAI_API_KEY",
  "EVE_BRIDGE_SECRET", "EVE_GATEWAY_SECRET", "POLYMATH_COMPANION_TOKEN",
  "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL",
]);
const CREDENTIAL = /(?:_KEY|_TOKEN|_SECRET)$|API_KEY|^COMPOSIO_AUTH_CONFIG_/i;
export class ConfigurationError extends Error {}
export function assertEvalEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  const forbidden = Object.entries(env).filter(([key, value]) => value && CREDENTIAL.test(key) && !ALLOWED.has(key)).map(([key]) => key);
  if (forbidden.length) throw new ConfigurationError(`Unsafe eval environment: unset ${forbidden.join(", ")}`);
}
