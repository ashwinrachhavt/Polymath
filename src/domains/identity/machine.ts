import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiClientUsage, apiClients } from "./schema";

/*
 * Machine-client authorization: the api credential that agents and the browser
 * companion present. Clerk owns authentication (it verified the token before
 * this runs); this resolves which api_client row it maps onto and whether that
 * client is still allowed to act — status active, not expired, under its daily
 * request ceiling.
 *
 * The owner supplies no id: the token is the identity. A revoked, expired, or
 * unknown client is the same "not allowed" on purpose.
 */

/** Daily request ceiling per client (D3). ponytail: one global number, per-client config when a second machine client needs a different bound. */
const DAILY_REQUEST_CEILING = 1_000;

export type MachineClient = {
  clientId: string;
  workspaceId: string;
  role: "owner" | "admin" | "member" | "viewer";
};

type MachineResolveResult =
  | { ok: true; client: MachineClient }
  | { ok: false; reason: "not_found" | "not_active" | "expired" | "rate_limited" };

/**
 * The pairing flow stores the Clerk machine subject in token_hash; a plain
 * equality lookup is the whole resolution — no fuzzy matching, no
 * client-supplied id. A revoked, expired, or unknown client is the same
 * "not allowed" on purpose.
 */
export async function resolveMachineClient(
  clerkSubject: string,
): Promise<MachineResolveResult> {
  const [client] = await db
    .select({
      id: apiClients.id,
      workspaceId: apiClients.workspaceId,
      status: apiClients.status,
      expiresAt: apiClients.expiresAt,
    })
    .from(apiClients)
    .where(and(eq(apiClients.tokenHash, clerkSubject), isNull(apiClients.archivedAt)))
    .limit(1);

  if (!client) return { ok: false, reason: "not_found" };
  if (client.status !== "active") return { ok: false, reason: "not_active" };
  if (client.expiresAt && client.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const day = new Date().toISOString().slice(0, 10);
  const [bumped] = await db
    .insert(apiClientUsage)
    .values({ workspaceId: client.workspaceId, clientId: client.id, day, requestCount: 1 })
    .onConflictDoUpdate({
      target: [apiClientUsage.clientId, apiClientUsage.day],
      // Raw sql keeps the increment atomic without a read-modify-write.
      set: { requestCount: sql`${apiClientUsage.requestCount} + 1` },
    })
    .returning({ requestCount: apiClientUsage.requestCount });

  if ((bumped?.requestCount ?? 0) > DAILY_REQUEST_CEILING) {
    return { ok: false, reason: "rate_limited" };
  }

  return {
    ok: true,
    client: {
      clientId: client.id,
      workspaceId: client.workspaceId,
      // Every machine client acts with its workspace's owner role in v1: one
      // owner per workspace, and roles arrive with the second member.
      role: "owner",
    },
  };
}
