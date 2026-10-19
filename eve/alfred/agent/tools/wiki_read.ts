import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { getWikiOverview, getWikiPageText } from "../../../../src/domains/knowledge/wiki";
import { WIKI_READ_CAPABILITY } from "../../../../src/domains/knowledge/wiki-agent";

/*
 * A read over the workspace's wiki: the index, a topic hub, or one article's
 * current text. It writes nothing. The workspace and user come from the
 * session's verified auth, never from the model's arguments.
 */
export default defineTool({
  description:
    "Read the workspace wiki: the master index, a topic hub by slug, or one article by artifact id. Use this to answer from the maintained layer before falling back to raw documents. Read-only; the run's frozen policy must allow wiki.read.",
  inputSchema: z.object({
    what: z.enum(["index", "topic", "article", "overview"]).describe("index = master index text; overview = topics, articles and log tail; topic/article need slug/artifactId."),
    slug: z.string().min(1).max(61).optional().describe("Topic slug, when what=topic."),
    artifactId: z.string().uuid().optional().describe("Article artifact id, when what=article."),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }
    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Axiom run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, WIKI_READ_CAPABILITY)) {
      return { ok: false as const, error: "wiki.read is not in this run's policy snapshot" };
    }
    const auth = { userId: current.principalId, workspaceId, role: "viewer" as const };
    if (input.what === "overview") {
      const overview = await getWikiOverview(auth);
      if (!overview) return { ok: true as const, empty: true as const };
      return {
        ok: true as const,
        topics: overview.topics,
        articles: overview.articles.map((a) => ({ artifactId: a.artifactId, title: a.title, summary: a.summary, topics: a.topics })),
        logTail: overview.logTail,
      };
    }
    if (input.what === "index") {
      const overview = await getWikiOverview(auth);
      return { ok: true as const, text: overview?.indexText ?? "" };
    }
    const id = input.artifactId;
    if (input.what === "article" && !id) return { ok: false as const, error: "artifactId is required for what=article" };
    if (input.what === "topic") {
      const overview = await getWikiOverview(auth);
      const topic = overview?.topics.find((t) => t.slug === input.slug);
      if (!topic) return { ok: false as const, error: `no topic hub named ${input.slug ?? ""}` };
      const page = await getWikiPageText(auth, topic.artifactId);
      return { ok: true as const, title: page?.title, text: page?.plainText ?? "" };
    }
    const page = await getWikiPageText(auth, id!);
    if (!page) return { ok: false as const, error: "no wiki page with that artifact id" };
    return { ok: true as const, title: page.title, versionNumber: page.versionNumber, text: page.plainText ?? "" };
  },
});
