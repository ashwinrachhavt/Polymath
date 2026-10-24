import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { normalizeNoteTags } from "./notes";
import { areas } from "./schema";

/*
 * Areas are declared by the person in one action: a name and the note tags
 * the area covers. Nothing infers an area. Updates are guarded on the
 * version the caller saw, like the rest of the knowledge domain; a lost
 * update is a stale_write, never a silent clobber. Archiving releases the
 * name (the unique index is partial on live rows) and keeps the row for
 * audit history.
 */

export class AreaError extends Error {
  constructor(
    readonly code: "invalid_area" | "name_taken" | "stale_write",
    message: string,
  ) {
    super(message);
    this.name = "AreaError";
  }
}

const MAX_TAGS_PER_AREA = 12;

function requireName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 80) throw new AreaError("invalid_area", "An area name is 1-80 characters.");
  return name;
}

function requireTags(raw: string[]): string[] {
  const tags = normalizeNoteTags(raw);
  if (tags.length === 0) throw new AreaError("invalid_area", "An area needs at least one tag to cover.");
  if (tags.length > MAX_TAGS_PER_AREA) throw new AreaError("invalid_area", `An area covers at most ${MAX_TAGS_PER_AREA} tags.`);
  return tags;
}

export async function declareArea(
  auth: AuthContext,
  input: { name: string; tags: string[]; idempotencyKey?: string },
) {
  const name = requireName(input.name);
  const tags = requireTags(input.tags);
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "declareArea", name, tags }, async () => {
      // A live same-named area (any case) collides; an archived one does not.
      const [taken] = await tx
        .select({ id: areas.id })
        .from(areas)
        .where(and(eq(areas.workspaceId, auth.workspaceId), sql`lower(${areas.name}) = lower(${name})`, isNull(areas.archivedAt)))
        .limit(1);
      if (taken) throw new AreaError("name_taken", `You already have an area named "${name}".`);
      const [area] = await tx
        .insert(areas)
        .values({ workspaceId: auth.workspaceId, name, tags, createdBy: auth.userId, updatedBy: auth.userId })
        .returning({ id: areas.id, version: areas.version });
      await recordAudit(
        auth,
        { action: "area.declared", subjectType: "area", subjectId: area.id, summary: `Area declared: ${name} (${tags.join(", ")})` },
        tx,
      );
      return area;
    });
    return value;
  });
}

export async function updateArea(
  auth: AuthContext,
  input: { areaId: string; expectedVersion: number; name?: string; tags?: string[]; idempotencyKey?: string },
) {
  const name = input.name === undefined ? undefined : requireName(input.name);
  const tags = input.tags === undefined ? undefined : requireTags(input.tags);
  if (name === undefined && tags === undefined) throw new AreaError("invalid_area", "Nothing to update.");
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "updateArea", ...input }, async () => {
      if (name !== undefined) {
        const [taken] = await tx
          .select({ id: areas.id })
          .from(areas)
          .where(
            and(
              eq(areas.workspaceId, auth.workspaceId),
              sql`lower(${areas.name}) = lower(${name})`,
              isNull(areas.archivedAt),
              sql`${areas.id} <> ${input.areaId}`,
            ),
          )
          .limit(1);
        if (taken) throw new AreaError("name_taken", `You already have an area named "${name}".`);
      }
      const [moved] = await tx
        .update(areas)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(tags !== undefined ? { tags } : {}),
          version: sql`${areas.version} + 1`,
          updatedAt: new Date(),
          updatedBy: auth.userId,
        })
        .where(
          and(
            eq(areas.id, input.areaId),
            eq(areas.workspaceId, auth.workspaceId),
            eq(areas.version, input.expectedVersion),
            isNull(areas.archivedAt),
          ),
        )
        .returning({ id: areas.id, version: areas.version });
      // Guarded row count: a concurrent update or archive loses cleanly.
      if (!moved) throw new AreaError("stale_write", "That area changed since you loaded it. Reload and try again.");
      await recordAudit(
        auth,
        { action: "area.updated", subjectType: "area", subjectId: moved.id, summary: `Area updated${name !== undefined ? `: ${name}` : ""}` },
        tx,
      );
      return moved;
    });
    return value;
  });
}

export async function archiveArea(
  auth: AuthContext,
  input: { areaId: string; expectedVersion: number; idempotencyKey?: string },
) {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "archiveArea", ...input }, async () => {
      const [moved] = await tx
        .update(areas)
        .set({ archivedAt: new Date(), version: sql`${areas.version} + 1`, updatedAt: new Date(), updatedBy: auth.userId })
        .where(
          and(
            eq(areas.id, input.areaId),
            eq(areas.workspaceId, auth.workspaceId),
            eq(areas.version, input.expectedVersion),
            isNull(areas.archivedAt),
          ),
        )
        .returning({ id: areas.id });
      if (!moved) throw new AreaError("stale_write", "That area changed since you loaded it. Reload and try again.");
      await recordAudit(auth, { action: "area.archived", subjectType: "area", subjectId: moved.id, summary: "Area archived" }, tx);
      return moved;
    });
    return value;
  });
}
