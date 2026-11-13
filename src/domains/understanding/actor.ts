import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { activeMembershipRole } from "@/domains/identity/resolve";
import { apiClients } from "@/domains/identity/schema";
import { db } from "@/lib/db";

/*
 * Understanding belongs to a person: attempts, review schedules and the jobs
 * that write them all name a user. An API key is not one, so the plugin acts
 * as the person who minted its key, as a member (a key never carries owner
 * authority). A session already is a person and passes through unchanged.
 */

export class KeyHasNoOwnerError extends Error {
  constructor() {
    super("This API key is not tied to a person in this workspace. Make a new key in Settings.");
    this.name = "KeyHasNoOwnerError";
  }
}

export async function actingAuth(auth: AuthContext): Promise<AuthContext> {
  if (auth.scopes === undefined) return auth;
  const [client] = await db
    .select({ createdBy: apiClients.createdBy })
    .from(apiClients)
    .where(and(eq(apiClients.id, auth.userId), eq(apiClients.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!client?.createdBy || !(await activeMembershipRole(auth.workspaceId, client.createdBy))) {
    throw new KeyHasNoOwnerError();
  }
  return { userId: client.createdBy, workspaceId: auth.workspaceId, role: "member" };
}
