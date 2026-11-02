import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { artifactLinks, artifacts, artifactVersions } from "./schema";
import { SEED_TAXONOMY } from "./taxonomy";

/*
 * Topic hubs (plan task 21): one hub artifact per canonical level-1 topic —
 * the vertex an idea's part_of edge lands on when it is filed under a topic.
 * Hubs are lazy (created on first use), singletons per workspace (an advisory
 * lock plus a re-check makes concurrent first use converge on one row), and
 * furniture rather than knowledge: kind "other", status "reviewed", excluded
 * from the Ideas list and from the semantic-edge pass by materializeSemanticEdges.
 */

export type TopicHub = { id: string; title: string };

export async function ensureTopicHub(auth: AuthContext, topicSlug: string): Promise<TopicHub> {
  // The taxonomy is frozen and read-only: a slug that is not a seeded L1
  // domain is a caller bug, and refusing keeps the graph free of invented labels.
  const topic = SEED_TAXONOMY.find((node) => node.slug === topicSlug && node.level === 1);
  if (!topic) throw new Error(`"${topicSlug}" is not a level-1 topic; hubs exist only for the seeded taxonomy.`);

  const hubWhere = () =>
    and(
      eq(artifacts.workspaceId, auth.workspaceId),
      eq(artifacts.kind, "other"),
      isNull(artifacts.archivedAt),
      // The marker is the hub's identity; the title alone could collide with
      // any other "other"-kind artifact a future feature mints.
      sql`${artifacts.metadata}->>'topicHubSlug' = ${topicSlug}`,
    );

  const existing = await db
    .select({ id: artifacts.id, title: artifacts.title })
    .from(artifacts)
    .where(hubWhere())
    .limit(1);
  if (existing.length > 0) return existing[0];

  // Concurrent first use: the pool read above may have missed a hub that is
  // being inserted right now. Take the per-topic advisory lock, then re-check
  // inside the transaction. The lock dies with the transaction, so there is
  // no janitor and no stuck row — exactly the 0259 idiom.
  return withTransaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('topic-hub:' || ${topicSlug}, 0))`);

    const rechecked = await tx
      .select({ id: artifacts.id, title: artifacts.title })
      .from(artifacts)
      .where(hubWhere())
      .limit(1);
    if (rechecked.length > 0) return rechecked[0];

    const [hub] = await tx
      .insert(artifacts)
      .values({
        workspaceId: auth.workspaceId,
        kind: "other",
        status: "reviewed",
        title: topic.displayName,
        // The marker makes the hub findable and the hub count honest; nothing
        // else reads "other" artifacts.
        metadata: { topicHubSlug: topicSlug },
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: artifacts.id, title: artifacts.title });
    const [version] = await tx
      .insert(artifactVersions)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: hub.id,
        versionNumber: 1,
        content: { type: "doc", content: [] },
        // The version's plain text names the topic, so the hub embeds as the
        // topic itself rather than as an empty card.
        plainText: topic.displayName,
        versionReason: "created",
      })
      .returning({ id: artifactVersions.id });
    await tx.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, hub.id));
    return hub;
  });
}

/**
 * File an idea under a canonical topic: the idea gains one part_of edge to
 * the topic's hub. Refiling the same pair is idempotent — the edge-key unique
 * index folds the duplicate, so a double write still leaves one edge.
 */
export async function fileIdeaUnderTopic(
  auth: AuthContext,
  input: { artifactId: string; topicSlug: string },
): Promise<void> {
  const hub = await ensureTopicHub(auth, input.topicSlug);
  await db
    .insert(artifactLinks)
    .values({
      workspaceId: auth.workspaceId,
      artifactId: input.artifactId,
      // Hubs are artifacts, not linkable cards: "artifact" keeps the edge
      // outside LINKABLE_KINDS backlink reads (and the target-kind check
      // has no "other", by design).
      targetType: "artifact",
      targetId: hub.id,
      label: hub.title,
      linkType: "part_of",
    })
    .onConflictDoNothing({
      target: [artifactLinks.artifactId, artifactLinks.targetType, artifactLinks.targetId],
    });
}
