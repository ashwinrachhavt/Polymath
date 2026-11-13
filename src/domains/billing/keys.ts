import { and, asc, eq } from "drizzle-orm";
import { cheapestModelOf, keyProviderById, keyProviders, type KeyProvider } from "@/domains/agents/models";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { openSecret, sealSecret } from "@/lib/secret-box";
import { reconcilePlan } from "./plans";
import { workspaceModelKeys } from "./schema";

/*
 * A workspace's own provider keys. The contract:
 *   - stored sealed (lib/secret-box), bound to workspace and provider;
 *   - proven with one tiny test call before they are saved;
 *   - never returned after save: the client sees `last4` and nothing else;
 *   - never logged: errors here carry no key text and no provider response.
 * The only code that reads a key back in the clear is loadOwnKeys, for the
 * resolver.
 */

export class KeyRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyRejectedError";
  }
}

export type KeyStatus = { provider: string; label: string; last4: string; validatedAt: Date };

const MAX_KEY_LENGTH = 512;

function context(workspaceId: string, provider: string) {
  return `${workspaceId}:${provider}`;
}

/*
 * One cheap chat call on the provider's cheapest model, 16 output tokens. 401
 * and 403 mean the key is wrong. 400/404/422 mean the provider authenticated
 * the key and merely disliked this probe, so the key stands. 402 and 429 mean
 * the key is real but has no credit or is throttled; saving it would only make
 * every later call fail, so it is refused with that reason. Anything else
 * (5xx, network) says nothing about the key, so nothing is saved.
 */
export async function testKey(
  provider: KeyProvider,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const model = cheapestModelOf(provider.id);
  if (!model) return { ok: false, reason: `${provider.label} has no model to test with.` };
  let status: number;
  try {
    const response = await fetchImpl(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    status = response.status;
  } catch {
    return { ok: false, reason: `Could not reach ${provider.label} to check the key. Try again in a minute.` };
  }
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 401 || status === 403) return { ok: false, reason: `${provider.label} rejected this key.` };
  if (status === 400 || status === 404 || status === 422) return { ok: true };
  if (status === 402 || status === 429) {
    return {
      ok: false,
      reason: `${provider.label} accepted the key but says it has no credit or is rate-limited. Fix that, then add it.`,
    };
  }
  return { ok: false, reason: `${provider.label} could not check the key just now. Try again in a minute.` };
}

export async function saveWorkspaceKey(
  auth: AuthContext,
  input: { provider: string; apiKey: string },
  deps: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<KeyStatus> {
  requireRole(auth, "owner");
  const provider = keyProviderById(input.provider);
  if (!provider) throw new KeyRejectedError("That provider is not supported.");
  const apiKey = input.apiKey.trim();
  if (!apiKey || apiKey.length > MAX_KEY_LENGTH || /\s/.test(apiKey)) {
    throw new KeyRejectedError("That does not look like an API key.");
  }
  // Sealing first: a deployment without an encryption key refuses before any key leaves for a test call.
  const sealedKey = sealSecret(apiKey, context(auth.workspaceId, provider.id), deps.env);
  const test = await testKey(provider, apiKey, deps.fetchImpl);
  if (!test.ok) throw new KeyRejectedError(test.reason);

  const validatedAt = new Date();
  await withTransaction(async (tx) => {
    const [row] = await tx
      .insert(workspaceModelKeys)
      .values({
        workspaceId: auth.workspaceId,
        provider: provider.id,
        sealedKey,
        last4: apiKey.slice(-4),
        validatedAt,
        createdBy: auth.userId,
      })
      .onConflictDoUpdate({
        target: [workspaceModelKeys.workspaceId, workspaceModelKeys.provider],
        set: { sealedKey, last4: apiKey.slice(-4), validatedAt, createdBy: auth.userId },
      })
      .returning({ id: workspaceModelKeys.id });
    await reconcilePlan(tx, auth);
    await recordAudit(
      auth,
      {
        action: "model_key.saved",
        subjectType: "model_key",
        subjectId: row.id,
        summary: `Added a ${provider.label} key ending ${apiKey.slice(-4)}`,
        metadata: { provider: provider.id },
      },
      tx,
    );
  });
  return { provider: provider.id, label: provider.label, last4: apiKey.slice(-4), validatedAt };
}

export async function deleteWorkspaceKey(auth: AuthContext, providerId: string): Promise<void> {
  requireRole(auth, "owner");
  await withTransaction(async (tx) => {
    const removed = await tx
      .delete(workspaceModelKeys)
      .where(and(eq(workspaceModelKeys.workspaceId, auth.workspaceId), eq(workspaceModelKeys.provider, providerId)))
      .returning({ id: workspaceModelKeys.id });
    if (removed.length === 0) return;
    await reconcilePlan(tx, auth);
    await recordAudit(
      auth,
      {
        action: "model_key.removed",
        subjectType: "model_key",
        subjectId: removed[0].id,
        summary: `Removed the ${keyProviderById(providerId)?.label ?? providerId} key`,
        metadata: { provider: providerId },
      },
      tx,
    );
  });
}

/** The masked view for Settings: provider, last four characters, when it was proven. */
export async function listKeyStatus(workspaceId: string): Promise<KeyStatus[]> {
  const rows = await db
    .select({
      provider: workspaceModelKeys.provider,
      last4: workspaceModelKeys.last4,
      validatedAt: workspaceModelKeys.validatedAt,
    })
    .from(workspaceModelKeys)
    .where(eq(workspaceModelKeys.workspaceId, workspaceId))
    .orderBy(asc(workspaceModelKeys.createdAt), asc(workspaceModelKeys.provider));
  const labels = new Map(keyProviders().map((p) => [p.id as string, p.label]));
  return rows.map((row) => ({ ...row, label: labels.get(row.provider) ?? row.provider }));
}

/** Decrypted keys, oldest first. For the resolver only: nothing here may reach a client or a log. */
export async function loadOwnKeys(
  workspaceId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ provider: string; apiKey: string }[]> {
  const rows = await db
    .select({ provider: workspaceModelKeys.provider, sealedKey: workspaceModelKeys.sealedKey })
    .from(workspaceModelKeys)
    .where(eq(workspaceModelKeys.workspaceId, workspaceId))
    .orderBy(asc(workspaceModelKeys.createdAt), asc(workspaceModelKeys.provider));
  return rows.map((row) => ({
    provider: row.provider,
    apiKey: openSecret(row.sealedKey, context(workspaceId, row.provider), env),
  }));
}

/** Whether the workspace holds any key of its own: the resolver's first question, and how a chat step's source is labelled. */
export async function hasOwnKey(workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: workspaceModelKeys.id })
    .from(workspaceModelKeys)
    .where(eq(workspaceModelKeys.workspaceId, workspaceId))
    .limit(1);
  return rows.length > 0;
}
