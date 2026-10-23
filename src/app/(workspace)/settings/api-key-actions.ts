"use server";

import {
  createApiClient,
  listApiClients,
  revokeApiClient,
  type ApiClientView,
} from "@/domains/identity/machine";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * API key management for the Settings screen. Session-authenticated only:
 * these actions ride getAuthContext, which a machine token cannot satisfy, so
 * a key can never mint or revoke keys. Owner-only: a key authenticates as the
 * whole workspace, so who may hold one is the owner's call.
 *
 * Dates cross the action boundary as ISO strings; the shown-once token is the
 * only secret material ever returned, and only at creation.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export type ApiKeyDto = Omit<ApiClientView, "pairedAt" | "lastSeenAt" | "expiresAt"> & {
  pairedAt: string;
  lastSeenAt: string | null;
  expiresAt: string | null;
};


function toDto(view: ApiClientView): ApiKeyDto {
  return {
    ...view,
    pairedAt: view.pairedAt.toISOString(),
    lastSeenAt: view.lastSeenAt?.toISOString() ?? null,
    expiresAt: view.expiresAt?.toISOString() ?? null,
  };
}

export async function listApiKeysAction(): Promise<Result<{ keys: ApiKeyDto[] }>> {
  try {
    const auth = await getAuthContext();
    requireRole(auth, "owner");
    return { ok: true, keys: (await listApiClients(auth)).map(toDto) };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not load API keys.") };
  }
}

export async function createApiKeyAction(input: {
  name: string;
  kind: "companion" | "machine";
  scopes: string[];
}): Promise<Result<{ key: ApiKeyDto; token: string }>> {
  try {
    const auth = await getAuthContext();
    requireRole(auth, "owner");
    const { client, token } = await createApiClient(auth, {
      name: String(input.name ?? ""),
      kind: input.kind === "machine" ? "machine" : "companion",
      scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : [],
    });
    return { ok: true, key: toDto(client), token };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not create the key.") };
  }
}

export async function revokeApiKeyAction(input: { clientId: string }): Promise<Result> {
  try {
    const auth = await getAuthContext();
    requireRole(auth, "owner");
    await revokeApiClient(auth, String(input.clientId ?? ""));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not revoke the key.") };
  }
}
