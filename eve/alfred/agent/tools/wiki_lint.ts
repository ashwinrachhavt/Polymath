import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { lintWiki } from "../../../../src/domains/knowledge/wiki";
import { WIKI_LINT_CAPABILITY } from "../../../../src/domains/knowledge/wiki-agent";

/*
 * The wiki health check. Read-only: it reports orphans, stale registrations
 * and gaps as a list and fixes nothing — the owner decides what to address.
 */
export default defineTool({
  description:
    "Health-check the workspace wiki: archived pages still registered, articles whose source was archived, empty topics, missing index or log. Use when the owner asks about wiki health or something in the wiki looks wrong. It will not repair anything — findings are reported and a fix is the owner's call — and it is not a content search; questions about what the wiki says belong to wiki_read. Read-only; the run's frozen policy must allow wiki.lint.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }
    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, WIKI_LINT_CAPABILITY)) {
      return { ok: false as const, error: "wiki.lint is not in this run's policy snapshot" };
    }
    const findings = await lintWiki({ userId: current.principalId, workspaceId, role: "viewer" });
    return { ok: true as const, findings };
  },
});
