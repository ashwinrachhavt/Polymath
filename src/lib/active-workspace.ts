import { cookies } from "next/headers";

/*
 * The per-device "which workspace am I in" preference (tenancy activation,
 * spec D1). Deliberately not a database column: each browser keeps its own
 * active workspace, and the resolver re-proves the value against the
 * membership table on every request, so a stale or forged cookie degrades to
 * the personal-workspace fallback instead of an error or a leak. The
 * membership row — not this cookie — is the only source of authorization.
 *
 * The cookie name is load-bearing: tests/integration/auth-resolution.test.ts
 * pins resolver behavior against this module through a mocked cookie store.
 */
const COOKIE_NAME = "polymath_active_workspace";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** The workspace id this device last switched to, or undefined when none. */
export async function readActiveWorkspaceCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value;
}

/**
 * Server actions and route handlers only: cookies() refuses writes during
 * render, and no render path calls this. One year keeps the selection across
 * browser restarts without making it an account-level setting.
 */
export async function writeActiveWorkspaceCookie(workspaceId: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
}
