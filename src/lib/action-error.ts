/*
 * Errors crossing a server-action boundary are UI copy, so they must be
 * authored, never borrowed: a driver error carries the failed SQL and its
 * bound values, which would leak schema and data into the client. Auth
 * rejections are recognized by their stable contract codes. A code selects
 * fixed authored copy; the thrown message crosses only when it matches an
 * authored guard template exactly, with every variable slot constrained to
 * the role enum or a scope-token charset, so a forged error can never inject
 * text through a recognized code. Everything else is answered with the
 * action's generic message.
 *
 * The server-side log is bounded to allowlisted metadata: the action's
 * fallback label, a known error class name (arbitrary input can populate
 * Error#name, so unrecognized names collapse to "Error"), and a standard
 * SQLSTATE code when the driver provides one (accepted from the error or
 * one level of cause, since the ORM wraps the driver error - the code only,
 * never the cause's message). The raw message is never logged: inline
 * literals, bindings and nested causes can be credential-bearing, and no
 * rewrite of the message is a reliable secret boundary.
 */
export function actionError(error: unknown, fallback: string): string {
  const authored = authRejectionCopy(error);
  if (authored) return authored;
  console.error("[action]", fallback, logMetadata(error));
  return fallback;
}

// Codes are fixed contract strings from lib/auth and lib/auth/guards; a
// driver SQLSTATE can never collide with them.
const FORBIDDEN_FALLBACK = "You don't have permission to do that.";

// The exact message shapes lib/auth/guards authors, with variable slots
// constrained so a forged message cannot smuggle content through a match.
const ROLE = "(?:viewer|member|admin|owner)";
const AUTH_FORBIDDEN_SHAPES = [
  new RegExp(`^Requires ${ROLE}; this member is ${ROLE}\\.$`),
  /^This API key does not carry the [a-z0-9:_-]{1,64} scope\.$/,
];

function authRejectionCopy(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  switch (code) {
    case "unauthorized":
      return "No signed-in session.";
    case "forbidden":
      return "This membership does not grant that.";
    case "AUTH_WORKSPACE_MISMATCH":
      return "Record belongs to another workspace.";
    case "AUTH_FORBIDDEN":
      return AUTH_FORBIDDEN_SHAPES.some((shape) => shape.test(error.message))
        ? error.message
        : FORBIDDEN_FALLBACK;
    default:
      return undefined;
  }
}

const LOGGABLE_NAMES = new Set(["Error", "TypeError", "RangeError", "PostgresError", "DrizzleQueryError"]);

function logMetadata(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: typeof error };
  const meta: { name: string; code?: string } = {
    name: LOGGABLE_NAMES.has(error.name) ? error.name : "Error",
  };
  meta.code =
    sqlstate((error as { code?: unknown }).code) ??
    sqlstate(((error as { cause?: unknown }).cause as { code?: unknown } | undefined)?.code);
  return meta;
}

function sqlstate(code: unknown): string | undefined {
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}
