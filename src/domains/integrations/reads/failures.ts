import type { ReadFailure } from "./github";

/*
 * Shared read-failure builders. Every provider module used to carry its own
 * copy of these two one-liners; the text differs only in the provider name,
 * so the copies lived here once. New read modules take these, not a fresh
 * local copy.
 */

export function malformedResponse(provider: string, what: string): ReadFailure {
  return { ok: false, code: "malformed_response", message: `${provider} returned a ${what} response this app does not recognise.` };
}

export function notConfiguredFor(provider: string): ReadFailure {
  return { ok: false, code: "not_configured", message: `This deployment cannot reach ${provider} yet.` };
}

/** Maps a failed transport read to the module's failure shape. */
export function transportFailure(result: { code: string; message: string }, provider: string): ReadFailure {
  return result.code === "not_configured"
    ? notConfiguredFor(provider)
    : { ok: false, code: "provider_error", message: result.message };
}
