"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { BookmarkPlus, FileText, Image, Loader2, NotebookPen, Plus, Presentation } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { Unavailable } from "@/components/workspace/ui";
import { ChatSurface } from "@/components/chat/chat-surface";
import { DeckView, InfographicView, type CitationSource } from "@/components/products/alfred/artifact-views";
import type { DocumentCitation } from "@/domains/knowledge/agent-search";
import type { DeckContent, InfographicContent } from "@/domains/knowledge/artifact-content";
import type { SourceRow } from "@/domains/knowledge/source-readiness";
import { DraftControls } from "../../../alfred/draft-controls";
import { saveAnswerAction } from "../../../alfred/save-answer-actions";
import { researchDossierCompanyAction } from "../../actions";
import { startNotebookRun } from "./chat-run-actions";
import { retryNotebookSourceAction } from "./add-source-actions";
import { AddSources } from "./add-sources";

/*
 * The notebook surface, laid out the way NotebookLM reads: sources on the left,
 * the grounded conversation in the middle, Studio on the right.
 *
 * The conversation is the shared agent interface — the same ChatSurface the
 * Assistant mounts, bound to this project through subjects. What differs is
 * scope, not interface: the run is restricted to this project's sources, and
 * the tools that scope allows are documents.search and notebook.open.
 *
 * Conversations persist (ASH-179). The history lists this notebook's chats;
 * opening one resumes it: a live run streams and keeps its composer, a finished
 * one reads back the stored thread and offers its last answer for saving to
 * notes. A finished conversation is history, not a dead end — a new question
 * starts a new conversation, same as the Assistant's own run page.
 *
 * Studio is this notebook's own capability panel: generate a report, deck, or
 * infographic from the pinned sources, research a company bounded to the project, and
 * review what runs produced.
 */

export type StudioOutput = "report" | "deck" | "infographic";

const OUTPUTS: Array<{ kind: StudioOutput; label: string; icon: typeof FileText; blurb: string }> = [
  { kind: "report", label: "Report", icon: FileText, blurb: "A written brief that cites its sources." },
  { kind: "deck", label: "Slide deck", icon: Presentation, blurb: "One idea per slide, each with its source." },
  { kind: "infographic", label: "Infographic", icon: Image, blurb: "One page, numbers attributed to documents." },
];

export type GeneratedArtifact = {
  artifactId: string;
  title: string;
  kind: string;
  status: string;
  /** Parsed structure when the artifact is a deck or infographic. */
  structured?: DeckContent | InfographicContent | null;
};

export type NotebookRun = { id: string; state: string; objective: string };

/** One row in the conversation history. */
export type NotebookChatRow = { runId: string; state: string; label: string; ago: string };

/** A resumed conversation: its run, whether it can still stream, and its stored thread. */
export type ActiveChat = {
  runId: string;
  live: boolean;
  thread: Array<{ kind: string; text: string; ago: string }>;
};

/** The readiness vocabulary the pane shows; one label per state of the existing field. */
const READINESS_LABEL: Record<SourceRow["readiness"], string> = {
  queued: "Reading...",
  extracting: "Reading...",
  embedding: "Reading...",
  ready: "Ready",
  failed: "Failed",
  unsupported: "Failed",
};

export default function NotebookSurface({
  notebook,
  sources,
  artifacts,
  vault = [],
  chats = [],
  activeChat = null,
  runs = [],
  runDrafts = {},
  lastAnswer,
}: {
  notebook: { projectId: string; title: string };
  sources: SourceRow[];
  artifacts: GeneratedArtifact[];
  /** The workspace's filed documents, for the pick-from-Vault control. */
  vault?: Array<{ id: string; title: string }>;
  /** This notebook's conversations, newest first. */
  chats?: NotebookChatRow[];
  /** The conversation selected with ?chat=, when it is one of this notebook's. */
  activeChat?: ActiveChat | null;
  /** This notebook's generate/research runs, newest first. */
  runs?: NotebookRun[];
  /** Draft artifact per producing run, when one exists. */
  runDrafts?: Record<string, { artifactId: string; status: string; version: number }>;
  /** The selected conversation's last grounded answer, when one exists. */
  lastAnswer?: { runId: string; answer: string; citations: DocumentCitation[] } | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<StudioOutput>("report");
  const [brief, setBrief] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const [starting, startStart] = useTransition();
  const [generating, setGenerating] = useState(false);
  const [researching, setResearching] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [discarded, setDiscarded] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const citationSources: CitationSource[] = sources.map((s) => ({ documentId: s.documentId, title: s.title }));

  const basePath = `/projects/${notebook.projectId}/notebook`;
  // A conversation started in this visit wins over one resumed from the URL;
  // after a refresh it is the same row in the history.
  const liveRunId = startedRunId ?? (activeChat?.live ? activeChat.runId : null);
  const readySources = sources.filter((s) => s.readiness === "ready").length;

  function retrySource(documentId: string) {
    // A new retry clears the previous attempt's note, so a stale result never
    // sits beside a fresh spinner.
    setRetryNote(null);
    setRetrying(documentId);
    void retryNotebookSourceAction({ projectId: notebook.projectId, documentId })
      .then((out) => setRetryNote(out.message))
      .catch((cause: unknown) =>
        setRetryNote(cause instanceof Error ? cause.message : "The source could not be retried."),
      )
      .finally(() => setRetrying(null));
  }

  function beginChat() {
    setMessage(null);
    startStart(async () => {
      const out = await startNotebookRun({ projectId: notebook.projectId, title: notebook.title });
      if (out.ok) {
        setStartedRunId(out.runId);
        // The new conversation joins the history on the next server render.
        router.refresh();
      } else {
        setMessage(out.error);
      }
    });
  }

  function saveAnswer() {
    if (!lastAnswer) return;
    setMessage(null);
    startSave(async () => {
      try {
        await saveAnswerAction({
          runId: lastAnswer.runId,
          title: `${notebook.title}: saved answer`,
          answer: lastAnswer.answer,
          citations: lastAnswer.citations,
          idempotencyKey: crypto.randomUUID(),
        });
        setMessage("Saved to your notes.");
        setDiscarded(true);
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : "The answer could not be saved.");
      }
    });
  }

  async function generate() {
    if (!brief.trim()) return;
    setGenerating(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/projects/${notebook.projectId}/generate`, {
        method: "POST",
        // A paid run starts here; the key makes a double click apply once.
        headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ brief, kind: selected }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { title?: string } | null;
        throw new Error(problem?.title ?? "The run could not be started.");
      }
      setBrief("");
      router.refresh();
      setMessage("Run started. It writes a draft for review below; nothing publishes.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The run could not be started.");
    } finally {
      setGenerating(false);
    }
  }

  async function research() {
    if (!companyName.trim()) return;
    setResearching(true);
    setMessage(null);
    try {
      const result = await researchDossierCompanyAction({ projectId: notebook.projectId, companyName, idempotencyKey: crypto.randomUUID() });
      if (!result.ok) throw new Error(result.error);
      setCompanyName("");
      router.refresh();
      setMessage(`Case study drafted from ${result.manifestSize} pinned ${result.manifestSize === 1 ? "source" : "sources"}.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The research pass failed.");
    } finally {
      setResearching(false);
    }
  }

  return (
    <div className="page-content grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[260px_minmax(0,1fr)_300px]">
      {/* Sources */}
      <aside aria-label="Sources" className="panel rounded-xl p-3">
        <div className="flex items-baseline justify-between gap-2 px-1">
          <h2 className="text-[13px] font-medium">Sources</h2>
        </div>
        <AddSources projectId={notebook.projectId} vault={vault} />
        {sources.length === 0 ? (
          <p className="mt-3 px-1 text-xs leading-relaxed text-muted-foreground">
            No sources yet. Add a URL, YouTube link, or file.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {sources.map((source) => (
              <li key={source.documentId} className="px-1 py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="min-w-0 truncate text-[13px]">{source.title}</p>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {READINESS_LABEL[source.readiness]}
                  </span>
                </div>
                <p className="text-xs break-words text-muted-foreground">
                  {source.kind === "video" ? "Video" : "Document"}
                  {source.detail ? ` · ${source.detail}` : ""}
                </p>
                {(source.readiness === "failed" || source.readiness === "unsupported") && (
                  <div className="mt-1 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => retrySource(source.documentId)}
                      disabled={retrying === source.documentId}
                    >
                      {retrying === source.documentId ? <Loader2 aria-hidden className="animate-spin" /> : null}
                      Retry
                    </Button>
                    {retrying === source.documentId && retryNote && (
                      <span className="text-xs text-muted-foreground">{retryNote}</span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {retryNote && (
          <p role="status" className="mt-1 px-1 text-xs leading-relaxed text-muted-foreground">
            {retryNote}
          </p>
        )}
      </aside>

      {/* Chat */}
      <section aria-label="Chat" className="panel flex min-h-[60vh] flex-col rounded-xl p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-[13px] font-medium">{notebook.title}</h2>
          {(activeChat || liveRunId) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStartedRunId(null);
                setDiscarded(false);
                router.push(basePath);
              }}
            >
              <Plus aria-hidden />
              New conversation
            </Button>
          )}
        </div>

        {chats.length > 0 && (
          <ul aria-label="Conversations" className="mt-2 flex flex-col border-b border-border pb-2">
            {chats.slice(0, 5).map((chat) => {
              const active = chat.runId === activeChat?.runId || chat.runId === startedRunId;
              return (
                <li key={chat.runId}>
                  <Link
                    href={`${basePath}?chat=${chat.runId}`}
                    onClick={() => setStartedRunId(null)}
                    className={`flex items-baseline gap-2 rounded-md px-1 py-1 text-[13px] hover:bg-muted ${
                      active ? "font-medium" : ""
                    }`}
                    aria-current={active ? "true" : undefined}
                  >
                    <span className="min-w-0 flex-1 truncate">{chat.label}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{chat.ago}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-3 flex-1">
          {liveRunId ? (
            <ChatSurface
              runId={liveRunId}
              subject={{ type: "project", id: notebook.projectId }}
              title={notebook.title}
              placeholder="Ask about these sources"
              showHeader={false}
            />
          ) : activeChat ? (
            <div>
              {(() => {
                // The thread's first user entry is the run's grounding
                // objective, not something the person typed; history starts
                // with the question they actually asked.
                const visible = activeChat.thread.filter((entry) => entry.kind === "user" || entry.kind === "assistant");
                const shown = visible.length > 0 && visible[0].kind === "user" ? visible.slice(1) : visible;
                return shown.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">This conversation has no messages yet.</p>
                ) : (
                  <div className="space-y-4">
                    {shown.map((entry, index) =>
                      entry.kind === "user" ? (
                        <div key={index} className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-[13px] leading-6">
                          {entry.text}
                        </div>
                      ) : (
                        <div key={index} className="max-w-[72ch] font-[family-name:var(--font-reading)] text-[16px] leading-7">
                          <Markdown text={entry.text} />
                        </div>
                      ),
                    )}
                  </div>
                );
              })()}
              {lastAnswer && lastAnswer.runId === activeChat.runId && !discarded ? (
                // The answer is the last message above; this bar acts on it
                // without repeating the body. The sources it would carry into
                // the note stay visible because they are the save's evidence.
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Save this answer
                    {lastAnswer.citations.length > 0
                      ? ` with its ${lastAnswer.citations.length === 1 ? "source" : "sources"} (${lastAnswer.citations.map((c) => c.title).join(", ")})`
                      : ""}{" "}
                    to your notes.
                  </p>
                  <span className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={saveAnswer} disabled={saving}>
                      {saving ? <Loader2 aria-hidden className="animate-spin" /> : <BookmarkPlus aria-hidden />}
                      Save to notes
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDiscarded(true)}>
                      Discard
                    </Button>
                  </span>
                </div>
              ) : null}
            </div>
          ) : readySources === 0 ? (
            <Unavailable feature="Grounded chat">
              No source in this notebook is ready yet. Add one and wait for it to say Ready, then ask away.
            </Unavailable>
          ) : (
            <div className="flex flex-col items-start gap-3 py-8">
              <Button onClick={beginChat} disabled={starting}>
                {starting ? <Loader2 aria-hidden className="animate-spin" /> : <NotebookPen aria-hidden />}
                Start a conversation
              </Button>
            </div>
          )}
          {message && (
            <p role="status" className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {message}
            </p>
          )}
        </div>
      </section>

      {/* Studio */}
      <aside aria-label="Studio" className="flex flex-col gap-3">
        <div className="panel rounded-xl p-3">
          <h2 className="text-[13px] font-medium">Studio</h2>
          <div className="mt-2 flex flex-col gap-1" role="radiogroup" aria-label="Output kind">
            {OUTPUTS.map((output) => {
              const Icon = output.icon;
              const active = selected === output.kind;
              return (
                <button
                  key={output.kind}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSelected(output.kind)}
                  className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted ${
                    active ? "bg-muted font-medium" : ""
                  }`}
                >
                  <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    {output.label}
                    <span className="block text-xs font-normal text-muted-foreground">{output.blurb}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void generate();
            }}
          >
            <Input
              aria-label="What should this output cover?"
              className="h-8 text-[13px]"
              placeholder="What should it cover?"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" disabled={generating || !brief.trim()}>
              {generating ? <Loader2 aria-hidden className="animate-spin" /> : null}
              Generate {OUTPUTS.find((o) => o.kind === selected)?.label}
            </Button>
          </form>
          <form
            className="mt-4 border-t border-border pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              void research();
            }}
          >
            <p className="text-xs font-medium text-muted-foreground">Research a company</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Reads only this notebook&apos;s pinned sources; gaps are marked, not filled.
            </p>
            <div className="mt-2 flex flex-col gap-2">
              <Input
                aria-label="Company name"
                className="h-8 text-[13px]"
                placeholder="Company name"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
              <Button type="submit" size="sm" variant="outline" disabled={researching || !companyName.trim()}>
                {researching ? <Loader2 aria-hidden className="animate-spin" /> : null}
                Research
              </Button>
            </div>
          </form>
        </div>

        <div className="panel rounded-xl p-3">
          <h2 className="text-[13px] font-medium">Runs</h2>
          {runs.length === 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Generated work lands here for review. Nothing publishes by itself.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-col gap-1 border-b border-border pb-2 last:border-0 last:pb-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="min-w-0 line-clamp-1 text-[13px]">{run.objective}</p>
                    <Badge variant="secondary" className="shrink-0 font-normal">
                      {run.state === "waiting_input" ? "Answered" : run.state}
                    </Badge>
                  </div>
                  <DraftControls runId={run.id} draft={runDrafts[run.id] ?? null} canSave={run.state === "succeeded" || run.state === "waiting_input"} />
                  {runDrafts[run.id] ? (
                    <a
                      href={`${basePath}?draft=${runDrafts[run.id].artifactId}`}
                      className="w-fit text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
                    >
                      Open the workbench
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel rounded-xl p-3">
          <h2 className="text-[13px] font-medium">In this notebook</h2>
          {artifacts.length === 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Nothing generated yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {artifacts.map((artifact) => (
                <li key={artifact.artifactId} className="border-b border-border pb-2 last:border-0 last:pb-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-[13px]">{artifact.title}</p>
                    <span className="text-muted-foreground shrink-0 text-xs">{artifact.kind}</span>
                  </div>
                  {artifact.structured?.kind === "deck" && (
                    <div className="mt-2">
                      <DeckView content={artifact.structured} sources={citationSources} />
                    </div>
                  )}
                  {artifact.structured?.kind === "infographic" && (
                    <div className="mt-2">
                      <InfographicView content={artifact.structured} sources={citationSources} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
