import { and, eq, max, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { agentProfiles } from "./schema";
import { agentProfileRevisions } from "./runtime-schema";

/*
 * Persistence for immutable profile revisions (ASH-117). Database constraints
 * are the authority; this function makes the intended transition easy and turns
 * conflicts into a named error. It never calls a provider.
 *
 * The execution/signal/invocation state machines that once lived here wrote to
 * tables no code read (verified dead, 2026-11); they were removed rather than
 * kept speculative. The profile-revision half has live callers in engine.ts and
 * conversations.ts.
 */

class RuntimeConflictError extends Error {
  constructor(
    readonly code: "not_found",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeConflictError";
  }
}

/** Stable JSON: object keys sorted, undefined dropped, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const hashCanonical = (value: unknown) => sha256Hex(canonicalJson(value));

const SECRET_KEY = /secret|token|password|passwd|authorization|api[_-]?key|credential|cookie/i;

/** Strips secret-looking values before anything is stored. Hidden reasoning is never passed in. */
export function redactForStorage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForStorage);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? "[redacted]" : redactForStorage(v),
      ]),
    );
  }
  return value;
}

/**
 * Captures the profile as it is now. Identical content reuses the existing
 * revision; an edited profile gets the next number. Serialized per profile so
 * two racing admissions cannot claim the same revision number.
 */
export async function captureProfileRevision(
  input: { workspaceId: string; profileId: string; createdBy?: string | null },
  client: typeof db = db,
) {
  return client.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agent_profile_revision:${input.profileId}`}, 0))`);
    const [profile] = await tx
      .select()
      .from(agentProfiles)
      .where(and(eq(agentProfiles.id, input.profileId), eq(agentProfiles.workspaceId, input.workspaceId)))
      .limit(1);
    if (!profile) throw new RuntimeConflictError("not_found", "profile not found in workspace");
    const snapshot = {
      name: profile.name,
      description: profile.description,
      instructions: profile.instructions,
      modelPolicy: profile.modelPolicy,
      allowedTools: profile.allowedTools,
      allowedAccounts: profile.allowedAccounts,
      contextPolicy: profile.contextPolicy,
      budgetPolicy: profile.budgetPolicy,
      memoryPolicy: profile.memoryPolicy,
    };
    const contentHash = await hashCanonical(snapshot);
    const [existing] = await tx
      .select()
      .from(agentProfileRevisions)
      .where(and(eq(agentProfileRevisions.agentProfileId, profile.id), eq(agentProfileRevisions.contentHash, contentHash)))
      .limit(1);
    if (existing) return existing;
    const [{ latest }] = await tx
      .select({ latest: max(agentProfileRevisions.revision) })
      .from(agentProfileRevisions)
      .where(eq(agentProfileRevisions.agentProfileId, profile.id));
    const [created] = await tx
      .insert(agentProfileRevisions)
      .values({
        workspaceId: input.workspaceId,
        agentProfileId: profile.id,
        revision: (latest ?? 0) + 1,
        contentHash,
        snapshot,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return created;
  });
}
