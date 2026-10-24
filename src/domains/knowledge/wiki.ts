import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuthContext } from "@/domains/identity/resolve";
import { auditEvents } from "@/domains/audit/schema";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { currentExtractionIdSubquery } from "./versions";
import { cleanTopics, openRouterWikiSummarizer, TOPIC_SLUG, type WikiSummarizer } from "@/integrations/wiki/summarizer";
import { artifactLinks, artifacts, artifactVersions, documentExtractions, documents, wikiPages } from "./schema";

/*
 * The wiki layer: a maintained second brain over the workspace's documents.
 * Documents stay immutable raw sources; ingesting one writes (or updates) its
 * article, refreshes the topic hubs and the master index, and appends one
 * line to the log. Every page is an artifact, so each refresh is a new
 * append-only version — the wiki never edits in place, and "what did the wiki
 * say last week" is always answerable.
 *
 * Hubs and the index are derived: their bodies are regenerated from the
 * wiki_pages registry, never hand-composed, so they cannot drift from what is
 * actually registered. Only article bodies come from the summarizer, and only
 * from the document's own extracted text.
 *
 * Lint is read-only: it reports orphans, stale registrations and gaps as a
 * list. It never auto-fixes; the owner decides what to address.
 */

export class WikiError extends Error {
  constructor(
    public readonly code: "document_not_found" | "no_extraction" | "no_topics" | "invalid_topic" | "page_not_found",
    message: string,
  ) {
    super(message);
    this.name = "WikiError";
  }
}

type Tx = Parameters<Parameters<typeof withTransaction>[0]>[0];

const INDEX_TITLE = "Wiki index";
const LOG_TITLE = "Wiki log";
const MAX_LOG_LINES = 500;

/** One artifact plus its first version. Returns both ids. */
async function createArtifact(
  tx: Tx,
  auth: AuthContext,
  input: { title: string; text: string; tags: string[]; kind?: "note" | "report" },
) {
  const [artifact] = await tx
    .insert(artifacts)
    .values({
      workspaceId: auth.workspaceId,
      kind: input.kind ?? "note",
      title: input.title.slice(0, 200),
      status: "generated",
      tags: input.tags,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning({ id: artifacts.id });
  const [version] = await tx
    .insert(artifactVersions)
    .values({
      workspaceId: auth.workspaceId,
      artifactId: artifact.id,
      versionNumber: 1,
      content: { text: input.text },
      plainText: input.text,
      reason: "generated",
      createdBy: auth.userId,
    })
    .returning({ id: artifactVersions.id });
  await tx.update(artifacts).set({ currentVersionId: version.id, embedError: null }).where(eq(artifacts.id, artifact.id));
  return artifact.id;
}

/** Appends a new version and moves the artifact's pointer. History is kept; nothing is overwritten. */
async function appendVersion(tx: Tx, auth: AuthContext, artifactId: string, text: string) {
  const [current] = await tx
    .select({ currentVersionId: artifacts.currentVersionId })
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!current) throw new WikiError("page_not_found", "Wiki page not found.");
  const [latest] = await tx
    .select({ versionNumber: artifactVersions.versionNumber, plainText: artifactVersions.plainText })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(desc(artifactVersions.versionNumber))
    .limit(1);
  if (latest?.plainText === text) return { changed: false, versionNumber: latest.versionNumber };
  const next = (latest?.versionNumber ?? 0) + 1;
  const [version] = await tx
    .insert(artifactVersions)
    .values({
      workspaceId: auth.workspaceId,
      artifactId,
      versionNumber: next,
      content: { text },
      plainText: text,
      reason: "generated",
      createdBy: auth.userId,
    })
    .returning({ id: artifactVersions.id });
  await tx
    .update(artifacts)
    .set({
      currentVersionId: version.id,
      embedError: null,
      updatedAt: new Date(),
      updatedBy: auth.userId,
      version: sql`${artifacts.version} + 1`,
    })
    .where(eq(artifacts.id, artifactId));
  return { changed: true, versionNumber: next };
}

async function currentText(tx: Tx, artifactId: string): Promise<string> {
  const [row] = await tx
    .select({ plainText: artifactVersions.plainText })
    .from(artifacts)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  return row?.plainText ?? "";
}

/** The index and the log exist before anything else writes. Idempotent; a race lands on the same row. */
async function ensureSkeleton(tx: Tx, auth: AuthContext) {
  for (const role of ["index", "log"] as const) {
    const [existing] = await tx
      .select({ id: wikiPages.id, artifactId: wikiPages.artifactId })
      .from(wikiPages)
      .where(and(eq(wikiPages.workspaceId, auth.workspaceId), eq(wikiPages.role, role)))
      .limit(1);
    if (existing) continue;
    const title = role === "index" ? INDEX_TITLE : LOG_TITLE;
    const artifactId = await createArtifact(tx, auth, {
      title,
      text: role === "index" ? "# Wiki index\n\nNothing ingested yet.\n" : "# Wiki log\n",
      tags: ["wiki", `wiki:${role}`],
    });
    await tx
      .insert(wikiPages)
      .values({ workspaceId: auth.workspaceId, role, artifactId, createdBy: auth.userId, updatedBy: auth.userId })
      .onConflictDoNothing({ target: [wikiPages.workspaceId, wikiPages.role], where: sql`role in ('index', 'log')` });
  }
}

async function ensureTopicHub(tx: Tx, auth: AuthContext, slug: string): Promise<string> {
  const [existing] = await tx
    .select({ artifactId: wikiPages.artifactId })
    .from(wikiPages)
    .where(and(eq(wikiPages.workspaceId, auth.workspaceId), eq(wikiPages.role, "topic"), eq(wikiPages.topicSlug, slug)))
    .limit(1);
  if (existing) return existing.artifactId;
  const artifactId = await createArtifact(tx, auth, {
    title: `Topic: ${slug}`,
    text: `# ${slug}\n\nNo articles yet.\n`,
    tags: ["wiki", "wiki:topic", `topic:${slug}`],
  });
  await tx
    .insert(wikiPages)
    .values({ workspaceId: auth.workspaceId, role: "topic", topicSlug: slug, artifactId, createdBy: auth.userId, updatedBy: auth.userId })
    .onConflictDoNothing({ target: [wikiPages.workspaceId, wikiPages.topicSlug], where: sql`role = 'topic'` });
  const [row] = await tx
    .select({ artifactId: wikiPages.artifactId })
    .from(wikiPages)
    .where(and(eq(wikiPages.workspaceId, auth.workspaceId), eq(wikiPages.role, "topic"), eq(wikiPages.topicSlug, slug)))
    .limit(1);
  return row.artifactId;
}

/** A hub's body is derived from the registry: every registered article in the topic, one line each. */
async function regenerateTopicHub(tx: Tx, auth: AuthContext, slug: string) {
  const rows = await tx
    .select({ artifactId: wikiPages.artifactId, summary: wikiPages.summary, title: artifacts.title })
    .from(wikiPages)
    .innerJoin(artifacts, and(eq(artifacts.id, wikiPages.artifactId), sql`${artifacts.archivedAt} is null`))
    .where(
      and(
        eq(wikiPages.workspaceId, auth.workspaceId),
        eq(wikiPages.role, "article"),
        sql`${wikiPages.topicSlugs} @> ${JSON.stringify([slug])}::jsonb`,
      ),
    )
    .orderBy(desc(wikiPages.updatedAt));
  const hubArtifactId = await ensureTopicHub(tx, auth, slug);
  const lines = rows.map((r) => `- **${r.title}** — ${r.summary ?? "No summary."}`);
  const body = [`# ${slug}`, "", `${rows.length} article${rows.length === 1 ? "" : "s"}.`, "", ...lines, ""].join("\n");
  await appendVersion(tx, auth, hubArtifactId, body);
  await tx
    .update(wikiPages)
    .set({ summary: `${rows.length} article${rows.length === 1 ? "" : "s"}`, updatedAt: new Date(), updatedBy: auth.userId })
    .where(and(eq(wikiPages.workspaceId, auth.workspaceId), eq(wikiPages.role, "topic"), eq(wikiPages.topicSlug, slug)));
}

/** The index is derived too: every topic with its count, plus the totals. */
async function regenerateIndex(tx: Tx, auth: AuthContext) {
  const topics = await tx
    .select({ slug: wikiPages.topicSlug, summary: wikiPages.summary })
    .from(wikiPages)
    .where(and(eq(wikiPages.workspaceId, auth.workspaceId), eq(wikiPages.role, "topic")))
    .orderBy(wikiPages.topicSlug);
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(wikiPages)
    .where(and(eq(wikiPages.workspaceId, auth.workspaceId), eq(wikiPages.role, "article")));
  const [indexPage] = await tx
    .select({ artifactId: wikiPages.artifactId })
    .from(wikiPages)
    .where(and(eq(wikiPages.workspaceId, auth.workspaceId), eq(wikiPages.role, "index")))
    .limit(1);
  const lines = topics.map((t) => `- **${t.slug}** (${t.summary ?? "0 articles"})`);
  const body = [
    "# Wiki index",
    "",
    `${count} article${count === 1 ? "" : "s"} across ${topics.length} topic${topics.length === 1 ? "" : "s"}.`,
    "",
    ...(lines.length ? lines : ["Nothing ingested yet."]),
    "",
  ].join("\n");
  if (indexPage) await appendVersion(tx, auth, indexPage.artifactId, body);
}

/** One line per ingest, appended as a new log version; the tail is kept bounded. */
async function appendLog(tx: Tx, auth: AuthContext, line: string) {
  const [logPage] = await tx
    .select({ artifactId: wikiPages.artifactId })
    .from(wikiPages)
    .where(and(eq(wikiPages.workspaceId, auth.workspaceId), eq(wikiPages.role, "log")))
    .limit(1);
  if (!logPage) return;
  const existing = await currentText(tx, logPage.artifactId);
  const kept = existing.split("\n").filter((l) => !l.startsWith("- ")).concat(
    existing.split("\n").filter((l) => l.startsWith("- ")).slice(-(MAX_LOG_LINES - 1)),
  );
  await appendVersion(tx, auth, logPage.artifactId, `${kept.join("\n").replace(/\n*$/, "\n")}${line}\n`);
}

export type IngestResult = {
  artifactId: string;
  title: string;
  topics: string[];
  /** False when the same extraction was already ingested and nothing changed. */
  changed: boolean;
};

/**
 * Ingests one document into the wiki. The document's newest succeeded
 * extraction is the only input the summarizer sees. Re-ingesting after a
 * re-extraction appends a new article version and re-derives the hubs;
 * re-ingesting an unchanged extraction writes nothing new.
 */
export async function ingestDocument(
  auth: AuthContext,
  input: { documentId: string; topics?: string[]; summarizer?: WikiSummarizer },
): Promise<IngestResult> {
  const [doc] = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId), sql`${documents.archivedAt} is null`))
    .limit(1);
  if (!doc) throw new WikiError("document_not_found", "No such document in this workspace.");
  // The restored version is what the document reads as, so wiki reads it too.
  const [extraction] = await db
    .select({ text: documentExtractions.text, contentHash: documentExtractions.contentHash })
    .from(documentExtractions)
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .where(
      and(
        eq(documentExtractions.documentId, doc.id),
        eq(documentExtractions.workspaceId, auth.workspaceId),
        eq(documentExtractions.status, "succeeded"),
        eq(documentExtractions.id, sql`(${currentExtractionIdSubquery()})`),
      ),
    )
    .limit(1);
  if (!extraction?.text) {
    throw new WikiError("no_extraction", "This document has no succeeded extraction to read yet.");
  }

  const summarizer = input.summarizer ?? openRouterWikiSummarizer();
  const summary = await summarizer.summarize(extraction.text, doc.title);
  // The caller's explicit topics win; otherwise the summarizer's, cleaned either way.
  const topics = cleanTopics(input.topics ?? summary.topics);
  if (topics.length === 0) {
    throw new WikiError("no_topics", "No usable topic for this article. Pass one explicitly.");
  }
  for (const t of topics) {
    if (!TOPIC_SLUG.test(t)) throw new WikiError("invalid_topic", `Not a topic slug: ${t}`);
  }

  return withTransaction(async (tx) => {
    await ensureSkeleton(tx, auth);

    const [existing] = await tx
      .select({ id: wikiPages.id, artifactId: wikiPages.artifactId, pinnedContentHash: wikiPages.pinnedContentHash })
      .from(wikiPages)
      .where(and(eq(wikiPages.workspaceId, auth.workspaceId), eq(wikiPages.role, "article"), eq(wikiPages.documentId, doc.id)))
      .limit(1);

    let artifactId: string;
    let changed: boolean;
    if (!existing) {
      artifactId = await createArtifact(tx, auth, { title: summary.title, text: summary.body, tags: ["wiki", "wiki:article"] });
      await tx
        .insert(wikiPages)
        .values({
          workspaceId: auth.workspaceId,
          role: "article",
          documentId: doc.id,
          artifactId,
          topicSlugs: topics,
          summary: summary.summary,
          pinnedContentHash: extraction.contentHash,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .onConflictDoNothing({ target: [wikiPages.workspaceId, wikiPages.documentId], where: sql`role = 'article'` });
      await tx
        .insert(artifactLinks)
        .values({ workspaceId: auth.workspaceId, artifactId, targetType: "document", targetId: doc.id, label: "source" })
        .onConflictDoNothing({ target: [artifactLinks.artifactId, artifactLinks.targetType, artifactLinks.targetId] });
      changed = true;
    } else {
      artifactId = existing.artifactId;
      if (existing.pinnedContentHash === extraction.contentHash) {
        // Same text already ingested: only a topic override can still change something.
        changed = false;
      } else {
        const result = await appendVersion(tx, auth, artifactId, summary.body);
        changed = result.changed;
      }
      await tx
        .update(artifacts)
        .set({ title: summary.title.slice(0, 200), updatedAt: new Date(), updatedBy: auth.userId })
        .where(eq(artifacts.id, artifactId));
      await tx
        .update(wikiPages)
        .set({ topicSlugs: topics, summary: summary.summary, pinnedContentHash: extraction.contentHash, updatedAt: new Date(), updatedBy: auth.userId })
        .where(eq(wikiPages.id, existing.id));
    }

    for (const slug of topics) await regenerateTopicHub(tx, auth, slug);
    await regenerateIndex(tx, auth);
    await appendLog(
      tx,
      auth,
      `- ${new Date().toISOString().slice(0, 10)} ${existing ? "updated" : "ingested"} "${summary.title}" (topics: ${topics.join(", ")}; ${summarizer.name})`,
    );
    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: existing ? "wiki.article_updated" : "wiki.article_ingested",
      subjectType: "artifact",
      subjectId: artifactId,
      summary: `Wiki ${existing ? "updated" : "ingested"}: ${summary.title}`,
    });
    return { artifactId, title: summary.title, topics, changed };
  });
}

export type WikiLintFinding = { code: string; message: string; artifactId?: string };

/** Read-only health check. Reports; never fixes. */
export async function lintWiki(auth: AuthContext): Promise<WikiLintFinding[]> {
  const findings: WikiLintFinding[] = [];
  const rows = await db
    .select({
      id: wikiPages.id,
      role: wikiPages.role,
      topicSlug: wikiPages.topicSlug,
      topicSlugs: wikiPages.topicSlugs,
      artifactId: wikiPages.artifactId,
      documentId: wikiPages.documentId,
      artifactArchivedAt: artifacts.archivedAt,
      documentArchivedAt: documents.archivedAt,
    })
    .from(wikiPages)
    .leftJoin(artifacts, eq(artifacts.id, wikiPages.artifactId))
    .leftJoin(documents, eq(documents.id, wikiPages.documentId))
    .where(eq(wikiPages.workspaceId, auth.workspaceId));

  const articlesByTopic = new Map<string, number>();
  let hasIndex = false;
  let hasLog = false;
  for (const row of rows) {
    if (row.role === "index") hasIndex = true;
    if (row.role === "log") hasLog = true;
    if (row.artifactArchivedAt) {
      findings.push({ code: "archived_page", message: `A ${row.role} page is archived but still registered.`, artifactId: row.artifactId });
      continue;
    }
    if (row.role === "article") {
      if (row.documentArchivedAt) {
        findings.push({ code: "source_archived", message: "An article's source document is archived; the article may be stale.", artifactId: row.artifactId });
      }
      const slugs = Array.isArray(row.topicSlugs) ? (row.topicSlugs as string[]) : [];
      if (slugs.length === 0) {
        findings.push({ code: "uncategorized", message: "An article belongs to no topic.", artifactId: row.artifactId });
      }
      for (const slug of slugs) articlesByTopic.set(slug, (articlesByTopic.get(slug) ?? 0) + 1);
    }
  }
  if (!hasIndex) findings.push({ code: "missing_index", message: "The wiki index page is missing; ingest any document to rebuild it." });
  if (!hasLog) findings.push({ code: "missing_log", message: "The wiki log page is missing; ingest any document to rebuild it." });
  for (const row of rows) {
    if (row.role === "topic" && row.topicSlug && !row.artifactArchivedAt && !articlesByTopic.get(row.topicSlug)) {
      findings.push({ code: "empty_topic", message: `Topic "${row.topicSlug}" has no articles.`, artifactId: row.artifactId });
    }
  }
  return findings;
}

export type WikiOverview = {
  indexText: string;
  topics: { slug: string; summary: string | null; artifactId: string }[];
  articles: { artifactId: string; title: string; summary: string | null; topics: string[]; updatedAt: Date }[];
  logTail: string[];
};

export async function getWikiOverview(auth: AuthContext): Promise<WikiOverview | null> {
  const pages = await db
    .select({
      role: wikiPages.role,
      topicSlug: wikiPages.topicSlug,
      summary: wikiPages.summary,
      artifactId: wikiPages.artifactId,
      topicSlugs: wikiPages.topicSlugs,
      title: artifacts.title,
      updatedAt: wikiPages.updatedAt,
      artifactArchivedAt: artifacts.archivedAt,
    })
    .from(wikiPages)
    .innerJoin(artifacts, eq(artifacts.id, wikiPages.artifactId))
    .where(eq(wikiPages.workspaceId, auth.workspaceId))
    .orderBy(desc(wikiPages.updatedAt));
  if (pages.length === 0) return null;
  let indexText = "";
  let logTail: string[] = [];
  const topics: WikiOverview["topics"] = [];
  const articles: WikiOverview["articles"] = [];
  for (const p of pages) {
    if (p.artifactArchivedAt) continue;
    if (p.role === "index") {
      const [v] = await db
        .select({ plainText: artifactVersions.plainText })
        .from(artifacts)
        .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
        .where(eq(artifacts.id, p.artifactId))
        .limit(1);
      indexText = v?.plainText ?? "";
    } else if (p.role === "log") {
      const [v] = await db
        .select({ plainText: artifactVersions.plainText })
        .from(artifacts)
        .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
        .where(eq(artifacts.id, p.artifactId))
        .limit(1);
      logTail = (v?.plainText ?? "").split("\n").filter((l) => l.startsWith("- ")).slice(-10).reverse();
    } else if (p.role === "topic" && p.topicSlug) {
      topics.push({ slug: p.topicSlug, summary: p.summary, artifactId: p.artifactId });
    } else if (p.role === "article") {
      articles.push({
        artifactId: p.artifactId,
        title: p.title,
        summary: p.summary,
        topics: Array.isArray(p.topicSlugs) ? (p.topicSlugs as string[]) : [],
        updatedAt: p.updatedAt,
      });
    }
  }
  return { indexText, topics: topics.sort((a, b) => a.slug.localeCompare(b.slug)), articles, logTail };
}

export async function getWikiPageText(auth: AuthContext, artifactId: string) {
  // A malformed id would reach Postgres as a uuid cast error and 500; it is
  // the same "no page here" as any other miss (see getDraftDetail).
  if (!z.string().uuid().safeParse(artifactId).success) return null;
  const [row] = await db
    .select({ title: artifacts.title, plainText: artifactVersions.plainText, versionNumber: artifactVersions.versionNumber, updatedAt: artifacts.updatedAt })
    .from(artifacts)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .innerJoin(wikiPages, eq(wikiPages.artifactId, artifacts.id))
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
    .limit(1);
  return row ?? null;
}
