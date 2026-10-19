import { and, desc, eq, isNull, max } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { outboxEvents } from "@/domains/audit/schema";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { CAPABILITY_CATALOG_VERSION, validateRoleCapabilities } from "./capabilities";
import type { AuthContext } from "./resolve";
import { roleDefinitionRevisions, roleDefinitions } from "./schema";

/*
 * ASH-121 AC03: custom role definitions. A definition is an immutable key
 * plus an editable label/description; every edit appends an immutable
 * revision validated against the capability catalog, so a custom role can
 * never invent a permission and a stored assignment can always be read
 * against the catalog version it was defined under. Definition is
 * owner-only (the catalog projection keeps role.define at the owner tier);
 * nothing here changes request authorization - assignment and enforcement
 * are later slices, and guards.ts RANK remains the surface.
 */

export class RoleDefinitionError extends Error {
  constructor(
    public readonly code: "role_definition_input" | "role_definition_not_found" | "role_definition_stale" | "role_key_taken" | "role_archived",
    message: string,
  ) {
    super(message);
    this.name = "RoleDefinitionError";
  }
}

const ROLE_KEY = /^[a-z][a-z0-9_]{0,49}$/;

export function validateRoleKey(key: string): string {
  const trimmed = key.trim();
  if (!ROLE_KEY.test(trimmed)) {
    throw new RoleDefinitionError("role_definition_input", "Role keys are 1-50 chars: lowercase letters, digits, underscores, starting with a letter.");
  }
  return trimmed;
}

function validateCaps(capabilities: string[]): string[] {
  const result = validateRoleCapabilities(capabilities);
  if (!result.ok) {
    throw new RoleDefinitionError("role_definition_input", `A custom role can only name catalog capabilities; unknown: ${result.invalid.join(", ")}.`);
  }
  return result.capabilities;
}

async function loadDefinition(tx: TxDrizzle, auth: AuthContext, id: string) {
  const [row] = await tx
    .select()
    .from(roleDefinitions)
    .where(and(eq(roleDefinitions.id, id), eq(roleDefinitions.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row) throw new RoleDefinitionError("role_definition_not_found", "No such role definition.");
  return row;
}

function assertFresh(row: { version: number; archivedAt: Date | null }, expectedVersion: number) {
  if (row.archivedAt) throw new RoleDefinitionError("role_archived", "That role definition is archived.");
  if (row.version !== expectedVersion) {
    throw new RoleDefinitionError("role_definition_stale", `Expected version ${expectedVersion}, found ${row.version}. Reload and retry.`);
  }
}

export async function defineRole(
  auth: AuthContext,
  input: { key: string; label: string; description?: string; capabilities: string[]; idempotencyKey?: string },
) {
  requireRole(auth, "owner");
  const key = validateRoleKey(input.key);
  const label = input.label.trim();
  if (!label) throw new RoleDefinitionError("role_definition_input", "A role needs a label.");
  const capabilities = validateCaps(input.capabilities);

  return withTransaction(async (tx) => {
    // State guards live INSIDE the receipt callback: a replayed receipt must
    // return the stored result without re-checking state the first attempt
    // itself changed (key taken, version bumped, archived).
    const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, { op: "defineRole", ...input }, async () => {
      const [taken] = await tx
        .select({ id: roleDefinitions.id })
        .from(roleDefinitions)
        .where(and(eq(roleDefinitions.workspaceId, auth.workspaceId), eq(roleDefinitions.key, key)))
        .limit(1);
      if (taken) throw new RoleDefinitionError("role_key_taken", `The key "${key}" is already used in this workspace.`);
      const [definition] = await tx
        .insert(roleDefinitions)
        .values({ workspaceId: auth.workspaceId, key, label, description: input.description?.trim() || null, createdBy: auth.userId, updatedBy: auth.userId })
        .returning();
      const [revision] = await tx
        .insert(roleDefinitionRevisions)
        .values({
          workspaceId: auth.workspaceId,
          roleDefinitionId: definition.id,
          revision: 1,
          catalogVersion: CAPABILITY_CATALOG_VERSION,
          capabilities,
          createdBy: auth.userId,
        })
        .returning();
      await recordAudit(
        auth,
        { action: "role.defined", subjectType: "role_definition", subjectId: definition.id, summary: `Defined custom role "${key}" (${capabilities.length} capabilities)`, metadata: { key, capabilities } },
        tx,
      );
      await tx.insert(outboxEvents).values({ workspaceId: auth.workspaceId, topic: "role.defined", payload: { roleDefinitionId: definition.id, key } });
      return { roleDefinitionId: definition.id, revisionId: revision.id };
    });
    return { ...value, key, replayed };
  });
}

export async function reviseRole(
  auth: AuthContext,
  input: { roleDefinitionId: string; expectedVersion: number; label?: string; description?: string; capabilities?: string[]; idempotencyKey?: string },
) {
  requireRole(auth, "owner");
  const capabilities = input.capabilities === undefined ? undefined : validateCaps(input.capabilities);
  const label = input.label?.trim();
  if (input.label !== undefined && !label) throw new RoleDefinitionError("role_definition_input", "A role needs a label.");

  return withTransaction(async (tx) => {
    const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, { op: "reviseRole", ...input }, async () => {
      const current = await loadDefinition(tx, auth, input.roleDefinitionId);
      assertFresh(current, input.expectedVersion);
      let revisionId: string | null = null;
      if (capabilities) {
        const [{ latest }] = await tx
          .select({ latest: max(roleDefinitionRevisions.revision) })
          .from(roleDefinitionRevisions)
          .where(eq(roleDefinitionRevisions.roleDefinitionId, current.id));
        const [revision] = await tx
          .insert(roleDefinitionRevisions)
          .values({
            workspaceId: auth.workspaceId,
            roleDefinitionId: current.id,
            revision: (latest ?? 0) + 1,
            catalogVersion: CAPABILITY_CATALOG_VERSION,
            capabilities,
            createdBy: auth.userId,
          })
          .returning();
        revisionId = revision.id;
      }
      await tx
        .update(roleDefinitions)
        .set({
          ...(label !== undefined ? { label } : {}),
          ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
          version: current.version + 1,
          updatedBy: auth.userId,
          updatedAt: new Date(),
        })
        .where(eq(roleDefinitions.id, current.id));
      await recordAudit(
        auth,
        { action: "role.revised", subjectType: "role_definition", subjectId: current.id, summary: `Revised custom role "${current.key}"${capabilities ? ` (${capabilities.length} capabilities)` : " (label/description)"}`, metadata: { key: current.key, capabilities: capabilities ?? null } },
        tx,
      );
      await tx.insert(outboxEvents).values({ workspaceId: auth.workspaceId, topic: "role.revised", payload: { roleDefinitionId: current.id, key: current.key } });
      return { roleDefinitionId: current.id, revisionId, version: current.version + 1 };
    });
    return { ...value, replayed };
  });
}

export async function archiveRole(auth: AuthContext, input: { roleDefinitionId: string; expectedVersion: number; idempotencyKey?: string }) {
  requireRole(auth, "owner");
  return withTransaction(async (tx) => {
    const { value, replayed } = await withReceipt(tx, auth, input.idempotencyKey, { op: "archiveRole", ...input }, async () => {
      const current = await loadDefinition(tx, auth, input.roleDefinitionId);
      assertFresh(current, input.expectedVersion);
      await tx
        .update(roleDefinitions)
        .set({ archivedAt: new Date(), version: current.version + 1, updatedBy: auth.userId, updatedAt: new Date() })
        .where(eq(roleDefinitions.id, current.id));
      await recordAudit(auth, { action: "role.archived", subjectType: "role_definition", subjectId: current.id, summary: `Archived custom role "${current.key}"; history preserved`, metadata: { key: current.key } }, tx);
      await tx.insert(outboxEvents).values({ workspaceId: auth.workspaceId, topic: "role.archived", payload: { roleDefinitionId: current.id, key: current.key } });
      return { roleDefinitionId: current.id, version: current.version + 1 };
    });
    return { ...value, replayed };
  });
}

/** Active definitions with their current capability sets, newest edit first. */
export async function listRoleDefinitions(auth: AuthContext) {
  const rows = await db
    .select()
    .from(roleDefinitions)
    .where(and(eq(roleDefinitions.workspaceId, auth.workspaceId), isNull(roleDefinitions.archivedAt)))
    .orderBy(desc(roleDefinitions.updatedAt));
  return rows;
}

/** One definition with its full immutable revision history, oldest first. */
export async function getRoleDefinition(auth: AuthContext, roleDefinitionId: string) {
  const [definition] = await db
    .select()
    .from(roleDefinitions)
    .where(and(eq(roleDefinitions.id, roleDefinitionId), eq(roleDefinitions.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!definition) return null;
  const revisions = await db
    .select()
    .from(roleDefinitionRevisions)
    .where(eq(roleDefinitionRevisions.roleDefinitionId, definition.id))
    .orderBy(roleDefinitionRevisions.revision);
  return { definition, revisions };
}
