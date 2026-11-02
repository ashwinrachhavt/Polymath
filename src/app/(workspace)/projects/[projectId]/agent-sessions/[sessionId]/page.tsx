import Link from "next/link";

import { getProjectDetail } from "@/domains/knowledge/projects";
import { cwdMatchesProjectRoot } from "@/lib/agent-artifacts/cwd-match";
import { getAuthContext } from "@/lib/auth";
import { SessionBriefPanel } from "@/components/polymath/workbench/session-brief-panel";
import { buildSessionBrief } from "@/domains/agents/session-brief";
import { timeAgoShort } from "@/lib/time";

import { getProjectSession } from "@/domains/agents/project-sessions";

export const metadata = { title: "Agent session · Polymath" };

/** How the header names each agent source — the agent's own product name. */
const AGENT_SOURCE_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/*
 * The session brief view (Workbench D3): one imported agent session, rendered
 * through PR2's deterministic brief panel. Reached from the project page's
 * "Agent sessions" section; the session must match this project's repo path
 * to render here — a session id from another project (or another workspace)
 * reads exactly like a missing one, because the address is not a global
 * namespace, it is this project's record.
 */
export default async function AgentSessionPage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = await params;
  const auth = await getAuthContext();

  const project = await getProjectDetail(auth, projectId);
  if (!project) {
    return <div className="page-content text-[13px] text-muted-foreground">This project does not exist.</div>;
  }

  const session = await getProjectSession(auth, sessionId);
  if (!session || !project.repoPath || !cwdMatchesProjectRoot(session.cwd, project.repoPath)) {
    return (
      <div className="page-content">
        <Link href={`/projects/${projectId}`} className="text-[13px] text-muted-foreground hover:underline">
          ← Back to {project.title}
        </Link>
        <p className="mt-6 text-[13px] text-muted-foreground">This agent session is not attached to this project.</p>
      </div>
    );
  }

  const brief = buildSessionBrief({ summary: session.summary, decisionNote: session.decisionNote });

  return (
    <div className="page-content">
      <div>
        <Link href={`/projects/${projectId}`} className="text-[13px] text-muted-foreground hover:underline">
          ← Back to {project.title}
        </Link>
        <h1 className="screen-title mt-3 text-[20px]">{brief.aiTitle ?? session.externalSessionId}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {AGENT_SOURCE_LABEL[session.source] ?? session.source} · started{" "}
          {session.startedAt ? timeAgoShort(session.startedAt) : "unknown"} · last activity{" "}
          {session.lastActivityAt ? timeAgoShort(session.lastActivityAt) : "unknown"}
        </p>
      </div>
      <div className="mt-6">
        <SessionBriefPanel brief={brief} />
      </div>
    </div>
  );
}
