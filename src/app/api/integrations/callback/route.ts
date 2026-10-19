import { NextResponse, type NextRequest } from "next/server";
import { completeConnection } from "@/domains/integrations/connect";
import { connectionAttempts } from "@/domains/integrations/schema";
import { ComposioNotConfiguredError, getConnectedAccount } from "@/domains/integrations/composio";
import { getAuthContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";

/*
 * Composio hosted-auth callback (D09). The browser lands here after the
 * hosted flow with our state token; we verify the connected account with
 * Composio, then flip the account active via completeConnection. The token
 * itself stays with Composio end to end. On any failure the attempt is left
 * for the owner to retry from the connectors page.
 */

function redirect(request: NextRequest, params: Record<string, string>) {
  const url = new URL("/command-center/integrations", request.url);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get("state");
  if (!state) return redirect(request, { connection: "missing-state" });

  let auth;
  try {
    auth = await getAuthContext();
  } catch {
    return redirect(request, { connection: "signed-out" });
  }

  const [attempt] = await db
    .select()
    .from(connectionAttempts)
    .where(and(eq(connectionAttempts.workspaceId, auth.workspaceId), eq(connectionAttempts.stateToken, state)))
    .limit(1);
  if (!attempt) return redirect(request, { connection: "unknown-attempt" });
  if (attempt.status === "completed") return redirect(request, { connection: "connected", alias: attempt.provider });
  if (!attempt.providerConnectedAccountId) return redirect(request, { connection: "incomplete" });

  try {
    const account = await getConnectedAccount(attempt.providerConnectedAccountId);
    if (account.status.toUpperCase() !== "ACTIVE") {
      return redirect(request, { connection: "provider-not-active", provider: attempt.provider });
    }
    await completeConnection(auth, {
      stateToken: state,
      providerConnectedAccountId: attempt.providerConnectedAccountId,
    });
    return redirect(request, { connection: "connected", provider: attempt.provider });
  } catch (error) {
    if (error instanceof ComposioNotConfiguredError) {
      return redirect(request, { connection: "not-configured" });
    }
    return redirect(request, { connection: "failed" });
  }
}
