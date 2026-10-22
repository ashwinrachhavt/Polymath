import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import type { AuthContext } from "./resolve";
import { apiClientUsage, apiClients } from "./schema";

/*
 * Machine-client authorization: the API key that agents and the browser
 * companion present. A key is `axm_<keyId>.<secret>`: the key id is the
 * lookup handle (stored in plaintext, indexed), the secret is the credential
 * and only its SHA-256 digest is stored, shown once at creation. Resolution
 * fetches the row by key id and compares digests in constant time, then
 * authorizes: status active, not expired, under its daily request ceiling.
 *
 * The owner supplies no id: the token is the identity. A revoked, expired, or
 * unknown client is the same "not allowed" on purpose.
 */

/** Daily request ceiling per client (D3). ponytail: one global number, per-client config when a second machine client needs a different bound. */
const DAILY_REQUEST_CEILING = 1_000;

/** Every scope an API key can carry today; the Settings UI offers exactly these. */
export const API_KEY_SCOPES = ["captures:read", "captures:write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type MachineClient = {
  clientId: string;
  workspaceId: string;
  role: "owner" | "admin" | "member" | "viewer";
  scopes: string[];
};

type MachineResolveResult =
  | { ok: true; client: MachineClient }
  | { ok: false; reason: "not_found" | "not_active" | "expired" | "rate_limited" };

type ClientRow = {
  id: string;
  workspaceId: string;
  status: "active" | "revoked";
  expiresAt: Date | null;
  scopes: unknown;
};

/*
 * Token shape. The key id is 12 base64url characters (9 random bytes), the
 * secret 43 (32 random bytes) — 256 bits of entropy, so the stored digest is
 * not brute-forceable and a leaked database leaks no usable credential.
 */
const API_KEY_FORMAT = /^axm_([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{43})$/;

export function mintApiKeySecret(): { keyId: string; secret: string; token: string } {
  const keyId = randomBytes(9).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  return { keyId, secret, token: `axm_${keyId}.${secret}` };
}

export function parseApiKey(token: string): { keyId: string; secret: string } | null {
  const match = API_KEY_FORMAT.exec(token);
  return match ? { keyId: match[1], secret: match[2] } : null;
}

/** Constant-time digest comparison; a mismatch must not leak where it differs. */
function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function assertScopes(scopes: string[]): ApiKeyScope[] {
  const valid = [...new Set(scopes)].filter((scope): scope is ApiKeyScope =>
    (API_KEY_SCOPES as readonly string[]).includes(scope),
  );
  if (valid.length === 0) {
    throw new Error(`Choose at least one scope (${API_KEY_SCOPES.join(", ")}).`);
  }
  return valid;
}

/**
 * Shared authorization for every resolved client row: lifecycle state, the
 * atomic daily-usage bump, and the last-seen stamp that makes "is this key
 * actually being used" answerable from the database.
 */
async function authorizeClient(client: ClientRow): Promise<MachineResolveResult> {
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

  await db.update(apiClients).set({ lastSeenAt: new Date() }).where(eq(apiClients.id, client.id));

  return {
    ok: true,
    client: {
      clientId: client.id,
      workspaceId: client.workspaceId,
      // Machine clients resolve to member: the highest role any /api/v1 route
      // requires today, and no higher — an API key must not mint owner-level
      // authority. The route's scope check (requireScope) narrows it further.
      role: "member",
      scopes: Array.isArray(client.scopes) ? (client.scopes as string[]) : [],
    },
  };
}

const CLIENT_COLUMNS = {
  id: apiClients.id,
  workspaceId: apiClients.workspaceId,
  status: apiClients.status,
  expiresAt: apiClients.expiresAt,
  scopes: apiClients.scopes,
} as const;

/**
 * Resolve a companion's own bearer token. New-format keys (`axm_<id>.<secret>`)
 * look the row up by key id and compare the secret's digest in constant time.
 * The first companion tokens were an undivided secret resolved by digest
 * lookup; they keep working until every stored row has a key id.
 */
export async function resolveCompanionToken(token: string): Promise<MachineResolveResult> {
  const parsed = parseApiKey(token);
  if (parsed) {
    const [client] = await db
      .select({ ...CLIENT_COLUMNS, tokenHash: apiClients.tokenHash })
      .from(apiClients)
      .where(and(eq(apiClients.keyId, parsed.keyId), isNull(apiClients.archivedAt)))
      .limit(1);
    if (!client || !digestsEqual(await sha256Hex(parsed.secret), client.tokenHash)) {
      // An unknown key id and a wrong secret are the same answer.
      return { ok: false, reason: "not_found" };
    }
    return authorizeClient(client);
  }
  return resolveMachineClient(await sha256Hex(token));
}

/**
 * The Clerk machine-token path stores the Clerk machine subject in
 * token_hash; a plain equality lookup is the whole resolution — no fuzzy
 * matching, no client-supplied id. Also serves legacy undivided companion
 * secrets, whose digest is what token_hash holds.
 */
export async function resolveMachineClient(
  tokenHash: string,
): Promise<MachineResolveResult> {
  const [client] = await db
    .select(CLIENT_COLUMNS)
    .from(apiClients)
    .where(and(eq(apiClients.tokenHash, tokenHash), isNull(apiClients.archivedAt)))
    .limit(1);

  if (!client) return { ok: false, reason: "not_found" };
  return authorizeClient(client);
}

/** What the Settings UI lists: everything about a key except its digest. */
export type ApiClientView = {
  id: string;
  name: string;
  kind: "companion" | "machine";
  keyId: string | null;
  scopes: string[];
  status: "active" | "revoked";
  pairedAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date | null;
};

function toView(row: typeof apiClients.$inferSelect): ApiClientView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    keyId: row.keyId,
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    status: row.status,
    pairedAt: row.pairedAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
  };
}

/** Active keys only: revocation archives the row, and the audit trail keeps the history. */
export async function listApiClients(auth: AuthContext): Promise<ApiClientView[]> {
  const rows = await db
    .select()
    .from(apiClients)
    .where(and(eq(apiClients.workspaceId, auth.workspaceId), isNull(apiClients.archivedAt)))
    .orderBy(apiClients.pairedAt);
  return rows.map(toView);
}

/**
 * The insert behind both creation paths (Settings UI and the pairing CLI):
 * mint the token, store only the digest, return the shown-once secret.
 */
export async function mintApiClient(input: {
  workspaceId: string;
  name: string;
  kind: "companion" | "machine";
  scopes: string[];
  createdBy?: string;
}): Promise<{ clientId: string; keyId: string; token: string }> {
  const name = input.name.trim();
  if (!name || name.length > 100) throw new Error("Name the key (1–100 characters).");
  const scopes = assertScopes(input.scopes);
  const { keyId, secret, token } = mintApiKeySecret();
  const [row] = await db
    .insert(apiClients)
    .values({
      workspaceId: input.workspaceId,
      name,
      kind: input.kind,
      keyId,
      tokenHash: await sha256Hex(secret),
      status: "active",
      scopes,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    })
    .returning({ id: apiClients.id });
  return { clientId: row.id, keyId, token };
}

/**
 * Owner-facing creation: mint the key and leave the audit row. The returned
 * token is the one and only time the secret exists outside the caller's
 * clipboard — the row holds its digest.
 */
export async function createApiClient(
  auth: AuthContext,
  input: { name: string; kind: "companion" | "machine"; scopes: string[] },
): Promise<{ client: ApiClientView; token: string }> {
  const minted = await mintApiClient({ ...input, workspaceId: auth.workspaceId, createdBy: auth.userId });
  const [row] = await db.select().from(apiClients).where(eq(apiClients.id, minted.clientId)).limit(1);
  await recordAudit(auth, {
    action: "api_client.created",
    subjectType: "api_client",
    subjectId: minted.clientId,
    summary: `API key "${input.name.trim()}" created (${input.kind}; scopes: ${assertScopes(input.scopes).join(", ")}).`,
  });
  return { client: toView(row), token: minted.token };
}

/** Revocation is a lifecycle event, not a delete: the row stays for audit. */
export async function revokeApiClient(auth: AuthContext, clientId: string): Promise<void> {
  const [row] = await db
    .select()
    .from(apiClients)
    .where(and(eq(apiClients.id, clientId), isNull(apiClients.archivedAt)))
    .limit(1);
  if (!row || row.workspaceId !== auth.workspaceId) throw new Error("No such API key.");
  await db
    .update(apiClients)
    .set({ status: "revoked", archivedAt: new Date(), updatedBy: auth.userId })
    .where(eq(apiClients.id, row.id));
  await recordAudit(auth, {
    action: "api_client.revoked",
    subjectType: "api_client",
    subjectId: row.id,
    summary: `API key "${row.name}" revoked.`,
  });
}
