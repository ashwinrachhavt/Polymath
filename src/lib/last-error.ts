/*
 * The id of the last error this tab rendered, for "Report a bug". Error
 * boundaries remember their `digest` (Next.js's handle for the server log);
 * the report sends it so a bug report and its server error share a
 * fingerprint. Module state, not storage: a reload starts clean.
 */

let lastErrorId: string | null = null;

export function rememberLastError(id: string | undefined): void {
  if (id) lastErrorId = id;
}

export function readLastErrorId(): string | null {
  return lastErrorId;
}
