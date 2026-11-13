"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  ArrowUp,
  BookmarkPlus,
  Ellipsis,
  FileText,
  Image,
  Loader2,
  Network,
  NotebookPen,
  PanelRight,
  Plus,
  Presentation,
  Settings2,
} from "lucide-react";
import { Popover } from "radix-ui";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip } from "@/components/ui/tooltip";
import { Markdown } from "@/components/markdown";
import { displayTitle } from "@/lib/display-text";
import { stripMentionContext } from "@/components/chat/mention-context";
import { Unavailable } from "@/components/workspace/ui";
import { ChatSurface } from "@/components/chat/chat-surface";
import { OutputRating } from "@/components/feedback/output-rating";
import type { RecordedStep } from "@/domains/agents/agent-steps";
import type { ChatRating } from "@/domains/feedback/ratings";
import { DeckView, InfographicView, type CitationSource } from "@/components/products/polymath/artifact-views";
import type { DocumentCitation } from "@/domains/knowledge/agent-search";
import type { DeckContent, InfographicContent } from "@/domains/knowledge/artifact-content";
import type { GenerationJobView } from "@/domains/jobs/state";
import type { SourceRow } from "@/domains/knowledge/source-readiness";
import { DraftControls } from "../../../polymath/draft-controls";
import { saveAnswerAction } from "../../../polymath/save-answer-actions";
import { researchDossierCompanyAction } from "../../actions";
import { startNotebookRun } from "./chat-run-actions";
import { retryNotebookSourceAction } from "./add-source-actions";
import { LearningStudio } from "./learning-studio";
import { SpaceHeader } from "./space-header";
import { StudioRail, type StudioSegment } from "./studio-rail";
import { useSurfaceJobs } from "@/components/jobs/generation-job-rows";
import { LEARNING_JOB_KIND_PREFIX, learningJobSubject } from "@/domains/learning/job-names";
import { randomId } from "@/lib/random-id";

/*
 * The notebook surface, laid out the way a Perplexity Space reads: a space
 * header (title, description, the sources as a tray of chips), the grounded
 * conversation as the centre of gravity, and Studio as a right rail from xl up
 * or a sheet below it.
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
 * Studio is this notebook's own capability rail (studio-rail.tsx): Create a
 * report, deck or infographic from the pinned sources, Learn (quiz, flashcards,
 * Explain It), Practice (Predict, Bug Hunt) and a Library of what runs
 * produced. Researching a company, bounded to the project's sources, lives in
 * the header's overflow menu.
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
  thread: Array<{ kind: string; text: string; ago: string; sequence: number }>;
  /** Recorded tool calls, so a reloaded live chat keeps each turn's step card. */
  steps: RecordedStep[];
  /** The viewer's ratings of this chat's answers. */
  ratings: ChatRating[];
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
  practice = null,
  practiceBusy = false,
  studioSegment = "create",
  results = null,
  learningJobs = [],
  description = null,
}: {
  notebook: { projectId: string; title: string };
  /** One line about what the notebook is for, shown under its title. */
  description?: string | null;
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
  /** The Practice panel (Predict, Bug Hunt and the exercises made), rendered by the page. */
  practice?: React.ReactNode;
  /** An exercise is still being prepared, so the Practice segment shows a dot. */
  practiceBusy?: boolean;
  /** The Studio segment shown first. */
  studioSegment?: StudioSegment;
  /** The Results panel (latest quiz, deck, Explain It), rendered by the page. */
  results?: React.ReactNode;
  /** This Notebook's unfinished quiz and deck jobs when the page rendered. */
  learningJobs?: GenerationJobView[];
}) {
  const router = useRouter();
  const learningSurface = useSurfaceJobs(learningJobs, {
    kindPrefix: LEARNING_JOB_KIND_PREFIX,
    subject: learningJobSubject.notebook(notebook.projectId),
  });
  const [studioOpen, setStudioOpen] = useState(false);
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
        // The new conversation joins the history in the action's own
        // revalidated render.
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
          idempotencyKey: randomId(),
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
        headers: { "content-type": "application/json", "Idempotency-Key": randomId() },
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
      const result = await researchDossierCompanyAction({
        projectId: notebook.projectId,
        companyName,
        idempotencyKey: randomId(),
      });
      if (!result.ok) throw new Error(result.error);
      setCompanyName("");
      setMessage(
        `Case study drafted from ${result.manifestSize} pinned ${result.manifestSize === 1 ? "source" : "sources"}.`,
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The research pass failed.");
    } finally {
      setResearching(false);
    }
  }

  const createPanel = (
    <section aria-label="Create" className="panel flex flex-col gap-3 rounded-xl p-3">
      <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Output kind">
        {OUTPUTS.map((output) => {
          const Icon = output.icon;
          const active = selected === output.kind;
          return (
            <Tooltip key={output.kind} content={output.blurb} side="bottom">
              <button
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setSelected(output.kind)}
                className={cn(
                  "border-border text-muted-foreground hover:bg-muted flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring",
                  active && "border-foreground/40 bg-muted text-foreground font-medium",
                )}
              >
                <Icon aria-hidden className="size-4" />
                {output.label}
              </button>
            </Tooltip>
          );
        })}
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void generate();
        }}
      >
        <Input
          aria-label="What should this output cover?"
          className="h-8 text-body-dense"
          placeholder="What should it cover?"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={generating || !brief.trim()}>
          {generating ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Generate {OUTPUTS.find((o) => o.kind === selected)?.label}
        </Button>
      </form>
    </section>
  );

  const libraryPanel = (
    <>
      <div className="panel rounded-xl p-3">
        <h2 className="text-body-dense font-medium">Runs</h2>
        {runs.length === 0 ? (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Generated work lands here for review. Nothing publishes by itself.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-col gap-1 border-b border-border pb-2 last:border-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="min-w-0 line-clamp-1 text-body-dense">
                    {displayTitle(stripMentionContext(run.objective)) || "Untitled run"}
                  </p>
                  <Badge variant="secondary" className="shrink-0 font-normal">
                    {run.state === "waiting_input" ? "Answered" : run.state}
                  </Badge>
                </div>
                <DraftControls draft={runDrafts[run.id] ?? null} />
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
        <h2 className="text-body-dense font-medium">In this notebook</h2>
        {artifacts.length === 0 ? (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Nothing generated yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {artifacts.map((artifact) => (
              <li key={artifact.artifactId} className="border-b border-border pb-2 last:border-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-body-dense">{artifact.title}</p>
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
    </>
  );

  const researchForm = (
    <form
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
          className="h-8 text-body-dense"
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
  );

  const headerActions = (
    <>
      <IconButton label="Concept view" href={`${basePath}/graph`} icon={<Network aria-hidden />} size="icon-sm" />
      <IconButton
        label="Notebook settings"
        href={`/projects/${notebook.projectId}/settings`}
        icon={<Settings2 aria-hidden />}
        size="icon-sm"
      />
      <Popover.Root>
        <Popover.Trigger asChild>
          <IconButton label="More" icon={<Ellipsis aria-hidden />} size="icon-sm" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            className="panel bg-popover text-popover-foreground z-50 w-64 rounded-xl p-3 outline-none"
          >
            <nav aria-label="Notebook" className="mb-3 flex flex-col border-b border-border pb-2 text-body-dense">
              <Link
                href={`/projects/${notebook.projectId}/agent-sessions`}
                className="rounded-md px-1 py-1 hover:bg-muted"
              >
                Agent sessions
              </Link>
            </nav>
            {researchForm}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <span className="xl:hidden">
        <IconButton
          label="Studio"
          icon={<PanelRight aria-hidden />}
          size="icon-sm"
          variant="outline"
          onClick={() => setStudioOpen(true)}
        />
      </span>
    </>
  );

  const rail = (
    <StudioRail
      initial={studioSegment}
      busy={{ learn: learningSurface.active, practice: practiceBusy }}
      panels={{
        create: createPanel,
        learn: (
          <>
            <LearningStudio
              projectId={notebook.projectId}
              surface={learningSurface}
              sources={sources
                .filter((source) => source.readiness === "ready")
                .map(({ documentId, title }) => ({ documentId, title }))}
            />
            {results}
          </>
        ),
        practice: practice,
        library: libraryPanel,
      }}
    />
  );

  return (
    <div className="page-content flex flex-col gap-5">
      <SpaceHeader
        projectId={notebook.projectId}
        title={notebook.title}
        description={description}
        sources={sources}
        vault={vault}
        retrying={retrying}
        retryNote={retryNote}
        onRetry={retrySource}
        actions={headerActions}
      />
      {/* The conversation is the centre; Studio is a rail beside it from xl up and a sheet below. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-label="Chat" className={cn("flex min-w-0 flex-col gap-3", liveRunId && "min-h-[60vh]")}>
          {chats.length > 0 || activeChat || liveRunId ? (
            <ul aria-label="Conversations" className="flex flex-wrap items-center gap-1.5">
              {activeChat || liveRunId ? (
                <li>
                  <IconButton
                    label="New conversation"
                    icon={<Plus aria-hidden />}
                    size="icon-sm"
                    variant="outline"
                    onClick={() => {
                      setStartedRunId(null);
                      setDiscarded(false);
                      router.push(basePath);
                    }}
                  />
                </li>
              ) : null}
              {chats.slice(0, 5).map((chat) => {
                const active = chat.runId === activeChat?.runId || chat.runId === startedRunId;
                return (
                  <li key={chat.runId} className="min-w-0">
                    <Tooltip content={`${chat.label}, ${chat.ago}`}>
                      <Link
                        href={`${basePath}?chat=${chat.runId}`}
                        onClick={() => setStartedRunId(null)}
                        className={cn(
                          "border-border flex h-7 max-w-[14rem] items-center rounded-full border px-2.5 text-body-dense hover:bg-muted",
                          active && "bg-muted font-medium",
                        )}
                        aria-current={active ? "true" : undefined}
                      >
                        <span className="truncate">{chat.label}</span>
                      </Link>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <div className="flex-1">
            {liveRunId ? (
              <ChatSurface
                runId={liveRunId}
                {...(activeChat?.runId === liveRunId
                  ? { initialSteps: activeChat.steps, ratings: activeChat.ratings }
                  : {})}
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
                  const visible = activeChat.thread.filter(
                    (entry) => entry.kind === "user" || entry.kind === "assistant",
                  );
                  const shown = visible.length > 0 && visible[0].kind === "user" ? visible.slice(1) : visible;
                  return shown.length === 0 ? (
                    <p className="text-body-dense text-muted-foreground">This conversation has no messages yet.</p>
                  ) : (
                    <div className="space-y-4">
                      {shown.map((entry, index) =>
                        entry.kind === "user" ? (
                          <div
                            key={index}
                            className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-body-dense leading-6"
                          >
                            {entry.text}
                          </div>
                        ) : (
                          <div
                            key={index}
                            className="prose-reading max-w-[var(--measure-prose)] font-[family-name:var(--font-reading)]"
                          >
                            <Markdown text={entry.text} />
                            <OutputRating
                              output={{ surface: "chat", runId: activeChat.runId, sequence: entry.sequence }}
                              initial={(() => {
                                const rating = activeChat.ratings.find((r) => r.sequence === entry.sequence);
                                return rating ? { score: rating.score, comment: rating.comment } : null;
                              })()}
                              className="mt-1"
                            />
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
              <button
                type="button"
                onClick={beginChat}
                disabled={starting}
                className="border-border bg-card text-muted-foreground hover:border-foreground/30 flex min-h-14 w-full items-center gap-3 rounded-2xl border px-4 text-left text-body outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-60"
              >
                {starting ? (
                  <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
                ) : (
                  <NotebookPen aria-hidden className="size-4 shrink-0" />
                )}
                <span className="flex-1">Ask about these sources</span>
                <ArrowUp aria-hidden className="bg-foreground text-background size-6 shrink-0 rounded-full p-1" />
                <span className="sr-only">Start a conversation</span>
              </button>
            )}
            {message && (
              <p role="status" className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {message}
              </p>
            )}
          </div>
        </section>
        <aside
          aria-label="Studio"
          className="hidden xl:sticky xl:top-[calc(var(--topbar-h,3rem)+1rem)] xl:block xl:max-h-[calc(100dvh-var(--topbar-h,3rem)-2rem)] xl:self-start xl:overflow-y-auto"
        >
          {rail}
        </aside>
      </div>
      <Sheet open={studioOpen} onOpenChange={setStudioOpen}>
        <SheetContent
          side="bottom"
          aria-describedby={undefined}
          className="max-h-[85dvh] overflow-y-auto p-4 xl:hidden"
        >
          <SheetTitle>Studio</SheetTitle>
          <SheetDescription className="sr-only">
            Make, learn from and practise on this notebook&apos;s sources.
          </SheetDescription>
          {rail}
        </SheetContent>
      </Sheet>
    </div>
  );
}
