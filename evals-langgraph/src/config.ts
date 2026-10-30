import { z } from "zod";
import { ConfigurationError } from "./env-gate";
export type AuthMode = { kind: "dev-user" } | { kind: "companion"; token: string };
export type HarnessConfig = { baseUrl: string; auth: AuthMode; timeoutMs: number; pollMs: number; maxAttempts: number };
export function readConfig(env: Readonly<Record<string, string | undefined>>): HarnessConfig {
  const url = new URL(env.POLYMATH_EVAL_BASE_URL ?? "http://127.0.0.1:3000");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ConfigurationError("POLYMATH_EVAL_BASE_URL must be a credential-free loopback HTTP URL (next dev)");
  }
  const token = env.POLYMATH_COMPANION_TOKEN;
  const auth: AuthMode = token ? { kind: "companion", token: z.string().regex(/^axm_[^.]+\..+$/).parse(token) } : { kind: "dev-user" };
  return { baseUrl: url.origin, auth, timeoutMs: 120_000, pollMs: 500, maxAttempts: 3 };
}
