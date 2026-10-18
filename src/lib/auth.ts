import { cache } from "react";
import { auth } from "@clerk/nextjs/server";
import { resolveAuthContext, type AuthContext } from "@/domains/identity/resolve";
import { resolveMachineClient } from "@/domains/identity/machine";
import { problemResponse } from "./problems";

/*
 * The two guards every server entry point goes through. Identity resolution
 * lives in src/domains/identity/ (a domain owns its tables); this file is the
 * thin Clerk-facing shell over it, and the only place UnauthorizedError is
 * turned into a response.
 *
 * Humans authenticate with a Clerk session; agents and the companion with a
 * Clerk machine token (m2m_token / api_key). Both converge on AuthContext, so
 * a route handler does not know or care which one arrived.
 */

export type { AuthContext };

export class UnauthorizedError extends Error {
  readonly code = "unauthorized";

  constructor() {
    super("No signed-in session.");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly code = "forbidden";

  constructor(readonly reason: string) {
    super(reason);
    this.name = "ForbiddenError";
  }
}

export const getAuthContext = cache(async (): Promise<AuthContext> => {
  const { userId } = await auth();
  if (!userId) throw new UnauthorizedError();
  return resolveAuthContext(userId);
});

/** Every server action begins withAuth(async (auth, input) => ...). */
export function withAuth<A extends unknown[]>(
  fn: (auth: AuthContext, ...args: A) => Promise<unknown>,
) {
  return async (...args: A) => {
    const ctx = await getAuthContext();
    return fn(ctx, ...args);
  };
}

/*
 * Humans OR machines. The Clerk session wins when one exists; otherwise a
 * machine token is resolved against api_clients. Route handlers for /api/v1/**
 * go through this; webhooks keep their HMAC auth instead.
 */
export const getAnyAuthContext = cache(async (): Promise<AuthContext> => {
  const session = await auth({ acceptsToken: "any" });
  if (session.isAuthenticated) {
    if ("userId" in session && session.userId) {
      return resolveAuthContext(session.userId);
    }
    // An m2m/api-key subject: "machineId" for m2m_token, "id" for api_key.
    const subject =
      "machineId" in session ? session.machineId : "id" in session ? session.id : null;
    if (subject) {
      const resolved = await resolveMachineClient(subject);
      if (!resolved.ok) throw new ForbiddenError(resolved.reason);
      return {
        userId: resolved.client.clientId,
        workspaceId: resolved.client.workspaceId,
        role: resolved.client.role,
      };
    }
  }
  throw new UnauthorizedError();
});

/** For /api/v1/** route handlers; webhooks keep their HMAC auth instead. */
export function authedHandler<C = unknown>(
  fn: (auth: AuthContext, request: Request, ctx: C) => Promise<Response>,
) {
  return async (request: Request, ctx: C): Promise<Response> => {
    try {
      const auth = await getAnyAuthContext();
      return await fn(auth, request, ctx);
    } catch (error) {
      if (error instanceof UnauthorizedError)
        return problemResponse(401, "unauthorized", "Sign in to use this endpoint.");
      if (error instanceof ForbiddenError) {
        if (error.reason === "rate_limited")
          return problemResponse(429, "rate_limited", "Daily request ceiling reached.");
        return problemResponse(403, "forbidden", "This client cannot use this endpoint.");
      }
      throw error;
    }
  };
}
