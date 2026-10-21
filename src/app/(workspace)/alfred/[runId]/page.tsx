import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { getAuthContext } from "@/lib/auth";
import { timeAgo } from "@/lib/time";
import { getRun, getRunPolicySnapshot, listDocumentSearchResults, listRunEvents } from "@/domains/agents/queries";
import { listThreads } from "@/domains/agents/thread";
import { collectCitations } from "@/domains/knowledge/agent-search";
import { draftsForRuns } from "@/domains/knowledge/studio";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { RunDetails } from "./details";

export const metadata = { title: "Conversation · Polymath" };

/*
 * One conversation, full page. The home lists rows; this is what a row opens.
 *
 * The transcript is the page. Everything the home shed about the run - model,
 * tools, budget, sources, timeline, controls - sits behind the Details
 * disclosure, because those are for when the owner is auditing what happened,
 * not for reading the answer. Decisions on approvals live in Reviews: this page
 * states that a run is waiting and links there rather than growing a second
 * decision surface.
 */

const ATTENTION_STATES = new Set(["waiting_input", "waiting_approval"]);

async function ConversationSurface({ runId }: { runId: string }) {
  await connection();
  const auth = await getAuthContext();
  // A malformed id would reach Postgres as a uuid cast error and 500; the API
  // route answers 404 for it, and this page must answer the same.
  if (!z.string().uuid().safeParse(runId).success) notFound();
  const run = await getRun(auth.workspaceId, runId);
  // Missing and other-workspace are the same answer on purpose (see getRun).
  if (!run) notFound();

  const [threads, searchResults, events, policy, drafts] = await Promise.all([
    listThreads(auth.workspaceId, [run.id]),
    listDocumentSearchResults(auth.workspaceId, [run.id]),
    listRunEvents(auth.workspaceId, run.id),
    getRunPolicySnapshot(run.id, auth.workspaceId),
    draftsForRuns(auth, [run.id]),
  ]);

  const thread = threads.get(run.id) ?? [];
  const citations = collectCitations(searchResults.get(run.id) ?? []);
  const unavailable = eveBridgeUnavailableReason();

  return (
    <div className="flex flex-col">
      <header className="page-header border-border bg-background/95 sticky top-12 z-10 border-b backdrop-blur">
        <div className="screen-heading">
          <div className="min-w-0 flex-1">
            <Link
              href="/alfred"
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
            >
              ← Recent
            </Link>
            <h1 className="screen-title mt-1">{run.objective}</h1>
            <p className="screen-description">
              Started {timeAgo(run.createdAt)}
              {run.endedAt ? ` · ended ${timeAgo(run.endedAt)}` : null}
            </p>
          </div>
          {ATTENTION_STATES.has(run.state) ? (
            <div className="screen-actions">
              <Link
                href="/reviews"
                className="focus-visible:ring-ring rounded-sm outline-none focus-visible:ring-3"
              >
                <Badge variant="secondary" className="font-normal">
                  Needs your reply
                </Badge>
              </Link>
            </div>
          ) : null}
        </div>
      </header>

      <div className="page-content flex flex-col gap-8">
        <section aria-label="Conversation" className="flex flex-col gap-5">
          {thread.length === 0 ? (
            <p className="text-muted-foreground text-[13px]">
              This conversation has no messages yet.
            </p>
          ) : (
            thread.map((entry) => (
              <article key={entry.sequence} className="flex flex-col gap-1.5">
                <p className="text-muted-foreground text-xs">
                  {entry.kind === "user" ? "You" : entry.kind === "assistant" ? "Polymath" : "Run"}
                  {" · "}
                  {timeAgo(entry.at)}
                </p>
                {entry.kind === "assistant" ? (
                  <div className="text-[13px] leading-relaxed">
                    <Markdown text={entry.text} />
                  </div>
                ) : (
                  <p className="text-[13px] whitespace-pre-wrap">{entry.text}</p>
                )}
              </article>
            ))
          )}

          <RunDetails
            run={run}
            policy={policy}
            citations={citations}
            events={events}
            draft={drafts.get(run.id) ?? null}
            unavailable={unavailable}
          />
        </section>
      </div>
    </div>
  );
}

/*
 * No Suspense boundary here on purpose: the workspace group's loading.tsx
 * already streams a shell, and a second boundary would only add a skeleton
 * the shell duplicates. Reads resolve before anything below renders, so the
 * transcript and the 404 are decided in one pass.
 */
export default async function ConversationPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <ConversationSurface runId={runId} />;
}
