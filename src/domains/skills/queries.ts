import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { skills, type Skill, type SkillFile } from "./schema";

/*
 * Reads for the skills surface and for the Eve resolver.
 *
 * Deliberately free of Next-only imports: `eve/alfred` loads `loadPinnedSkill`
 * through relative paths into this module, and a server action or `next/*`
 * import here would drag the request runtime into that bundle.
 */

/** The workspace's installed skills, by name. Feed the library surface. */
export async function listSkills(
  auth: { workspaceId: string },
  filter?: { enabled?: boolean },
): Promise<Skill[]> {
  const conditions: SQL[] = [
    eq(skills.workspaceId, auth.workspaceId),
    isNull(skills.archivedAt),
  ];
  if (filter?.enabled !== undefined) conditions.push(eq(skills.enabled, filter.enabled));
  return db
    .select()
    .from(skills)
    .where(and(...conditions))
    .orderBy(asc(skills.name));
}

/** A miss and a foreign id are the same null: the difference is not the caller's to learn. */
export async function getSkill(auth: { workspaceId: string }, id: string): Promise<Skill | null> {
  const [row] = await db
    .select()
    .from(skills)
    .where(
      and(eq(skills.workspaceId, auth.workspaceId), eq(skills.id, id), isNull(skills.archivedAt)),
    )
    .limit(1);
  return row ?? null;
}

/** Used by the Eve resolver. Returns the body, description and files for one workspace-scoped id. */
export async function loadPinnedSkill(
  workspaceId: string,
  skillId: string,
): Promise<{ description: string; body: string; files: SkillFile[] } | null> {
  const [row] = await db
    .select({
      description: skills.description,
      body: skills.body,
      files: skills.files,
    })
    .from(skills)
    .where(and(eq(skills.workspaceId, workspaceId), eq(skills.id, skillId)))
    .limit(1);
  // A disabled skill still resolves: the run pinned this id at start, and
  // disabling it later must not silently change what that run was told.
  return row ?? null;
}
