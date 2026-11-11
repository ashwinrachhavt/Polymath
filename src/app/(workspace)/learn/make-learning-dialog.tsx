"use client";

import { FileText, Inbox, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ComponentProps } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { WorkStatus } from "@/components/work-status";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { MAX_ITEM_COUNT, MAX_LEARNING_SOURCES, MIN_ITEM_COUNT } from "@/domains/learning/item-count";
import {
  findLearningSourcesAction,
  makeFlashcardsOrQuizAction,
  type LearningSourceOption,
  type LearningSourceRef,
} from "./make-actions";

/*
 * Make flashcards or a quiz from any sources: library documents and inbox
 * captures, picked together, no Notebook first. Learn opens it empty; the
 * inbox opens it with the captures in hand. On success it navigates to the
 * deck or the quiz, so the next thing on screen is the first card.
 */

type Kind = "flashcards" | "quiz";

const KINDS: Array<{ kind: Kind; label: string; blurb: string; noun: string }> = [
  { kind: "flashcards", label: "Flashcards", blurb: "Cards you rate to schedule reviews.", noun: "flashcards" },
  { kind: "quiz", label: "Quiz", blurb: "Questions with instant feedback.", noun: "questions" },
];

type Found = { documents: LearningSourceOption[]; captures: LearningSourceOption[] };

function sourceRef(source: LearningSourceOption): LearningSourceRef {
  return source.type === "document"
    ? { type: "document", id: source.id }
    : { type: "capture", id: source.id, version: source.version };
}

/** A button that opens the dialog; `initialSources` are picked when it opens. */
export function MakeLearningButton({
  initialSources = [],
  children = "New flashcards or quiz",
  ...buttonProps
}: { initialSources?: LearningSourceOption[] } & Omit<ComponentProps<typeof Button>, "onClick">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button {...buttonProps} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <MakeLearningDialog open={open} onOpenChange={setOpen} initialSources={initialSources} />
    </>
  );
}

function MakeLearningDialog({
  open,
  onOpenChange,
  initialSources,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSources: LearningSourceOption[];
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg">
        {/* Content mounts on open, so each opening starts from initialSources. */}
        <MakeLearningForm
          initialSources={initialSources.slice(0, MAX_LEARNING_SOURCES)}
          leftOut={Math.max(0, initialSources.length - MAX_LEARNING_SOURCES)}
          onPendingChange={setPending}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function MakeLearningForm({
  initialSources,
  leftOut,
  onPendingChange,
  onCancel,
}: {
  initialSources: LearningSourceOption[];
  /** Selected sources past the limit, which the dialog did not pick. */
  leftOut: number;
  onPendingChange: (pending: boolean) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const { notify } = useWorkspace();
  const [kind, setKind] = useState<Kind>("flashcards");
  const [selected, setSelected] = useState<LearningSourceOption[]>(initialSources);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [countText, setCountText] = useState("");
  const [error, setError] = useState<{ message: string; sourceId?: string } | null>(null);
  const [pending, startTransition] = useTransition();
  // A double submit of the same request while it runs replays its key; once
  // it answers, the next attempt is a new request, so a retry after a failure
  // is not refused as a replay of the failed one.
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    let stale = false;
    const timer = setTimeout(
      () => {
        void findLearningSourcesAction({ query }).then(
          (result) => {
            if (stale) return;
            if (result.ok) {
              setFound({ documents: result.documents, captures: result.captures });
              setSearchError(null);
            } else setSearchError(result.error);
          },
          () => {
            if (!stale) setSearchError("Could not load your sources.");
          },
        );
      },
      query ? 200 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);

  const choice = KINDS.find((item) => item.kind === kind) ?? KINDS[0];
  const trimmed = countText.trim();
  const count = trimmed === "" ? undefined : Number(trimmed);
  const countValid =
    count === undefined || (Number.isInteger(count) && count >= MIN_ITEM_COUNT && count <= MAX_ITEM_COUNT);
  const full = selected.length >= MAX_LEARNING_SOURCES;
  const problem =
    selected.length === 0
      ? "Pick at least one source."
      : !countValid
        ? `Choose a number from ${MIN_ITEM_COUNT} to ${MAX_ITEM_COUNT}, or leave it blank.`
        : null;

  function isPicked(source: LearningSourceOption) {
    return selected.some((item) => item.type === source.type && item.id === source.id);
  }

  function toggle(source: LearningSourceOption) {
    setError(null);
    setSelected((current) =>
      current.some((item) => item.type === source.type && item.id === source.id)
        ? current.filter((item) => !(item.type === source.type && item.id === source.id))
        : current.length >= MAX_LEARNING_SOURCES
          ? current
          : [...current, source],
    );
  }

  function create() {
    if (problem || pending) return;
    setError(null);
    const sources = selected.map(sourceRef);
    const signature = JSON.stringify([kind, sources, count]);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    const idempotencyKey = attempt.current.key;
    onPendingChange(true);
    startTransition(async () => {
      const result = await makeFlashcardsOrQuizAction({ kind, sources, count, idempotencyKey }).catch(() => ({
        ok: false as const,
        error: "The request did not reach Polymath. Try again.",
        failedSourceId: undefined,
      }));
      onPendingChange(false);
      attempt.current = null;
      if (!result.ok) {
        setError({ message: result.error, sourceId: result.failedSourceId });
        return;
      }
      if (result.notice) notify(result.notice);
      router.push(result.href);
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Make flashcards or a quiz</DialogTitle>
        <DialogDescription>
          Pick up to {MAX_LEARNING_SOURCES} sources from your library or inbox. Every card and question quotes them.
        </DialogDescription>
      </DialogHeader>

      <div className="-mx-4 flex min-h-0 flex-col gap-4 overflow-y-auto px-4">
        <div role="radiogroup" aria-label="What to make" className="grid grid-cols-2 gap-2">
          {KINDS.map((item) => (
            <label
              key={item.kind}
              className={cn(
                "flex cursor-pointer flex-col rounded-md border px-3 py-2 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring",
                kind === item.kind ? "border-foreground/40 bg-muted" : "border-border hover:bg-muted/60",
              )}
            >
              <input
                type="radio"
                name="make-learning-kind"
                value={item.kind}
                checked={kind === item.kind}
                onChange={() => setKind(item.kind)}
                className="sr-only"
              />
              <span className="text-body-dense font-medium">{item.label}</span>
              <span className="text-xs text-muted-foreground">{item.blurb}</span>
            </label>
          ))}
        </div>

        <section aria-label="Picked sources" className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {selected.length === 0
              ? "No sources picked yet."
              : `${selected.length} of ${MAX_LEARNING_SOURCES} sources picked.`}
          </p>
          {leftOut > 0 ? (
            <p className="text-xs text-muted-foreground">
              {leftOut} more selected {leftOut === 1 ? "was" : "were"} left out: one request reads up to{" "}
              {MAX_LEARNING_SOURCES}.
            </p>
          ) : null}
          {selected.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {selected.map((source) => (
                <li
                  key={source.type + source.id}
                  className={cn(
                    "flex max-w-full items-center gap-1 rounded-md border bg-muted/50 py-0.5 pr-0.5 pl-2 text-xs",
                    error?.sourceId === source.id ? "border-destructive text-destructive" : "border-border",
                  )}
                >
                  <SourceIcon type={source.type} />
                  <span className="max-w-56 truncate">{source.title}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${source.title}`}
                    disabled={pending}
                    onClick={() => toggle(source)}
                    className="rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section aria-label="Find sources" className="flex flex-col gap-2">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search your library and inbox"
              aria-label="Search your library and inbox"
              className="pl-8"
            />
          </div>
          {searchError ? (
            <p role="alert" className="text-xs text-destructive">
              {searchError}
            </p>
          ) : !found ? (
            <p role="status" className="text-xs text-muted-foreground">
              Loading your sources…
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto rounded-md border border-border">
              <SourceGroup
                label="Library"
                sources={found.documents}
                empty={query ? "No documents match." : "Your library is empty."}
                isPicked={isPicked}
                full={full}
                disabled={pending}
                onToggle={toggle}
              />
              <SourceGroup
                label="Inbox"
                sources={found.captures}
                empty={query ? "No captures match." : "Nothing waiting in your inbox."}
                isPicked={isPicked}
                full={full}
                disabled={pending}
                onToggle={toggle}
              />
            </div>
          )}
          {full ? (
            <p className="text-xs text-muted-foreground">
              That is the most one request reads. Remove one to pick another.
            </p>
          ) : null}
        </section>

        <label className="flex items-center justify-between gap-3 text-body-dense">
          <span>
            How many {choice.noun}
            <span className="block text-xs text-muted-foreground">
              Leave blank to size it from the sources ({MIN_ITEM_COUNT} to {MAX_ITEM_COUNT}).
            </span>
          </span>
          <Input
            type="number"
            inputMode="numeric"
            min={MIN_ITEM_COUNT}
            max={MAX_ITEM_COUNT}
            value={countText}
            placeholder="Automatic"
            aria-invalid={!countValid || undefined}
            onChange={(event) => setCountText(event.target.value)}
            className="w-28 shrink-0"
          />
        </label>

        {error ? <WorkStatus state={{ phase: "failed", label: error.message }} /> : null}
        {pending ? (
          <p role="status" className="text-xs text-muted-foreground">
            Reading the sources and checking every {kind === "quiz" ? "question" : "card"} against them. This can take a
            minute.
          </p>
        ) : null}
      </div>

      <DialogFooter className="items-center">
        {problem && selected.length > 0 ? <p className="mr-auto text-xs text-muted-foreground">{problem}</p> : null}
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={pending || problem !== null} onClick={create}>
          {pending ? `Making ${choice.label.toLowerCase()}…` : kind === "quiz" ? "Make quiz" : "Make flashcards"}
        </Button>
      </DialogFooter>
    </>
  );
}

function SourceIcon({ type }: { type: LearningSourceOption["type"] }) {
  const Icon = type === "document" ? FileText : Inbox;
  return <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}

function SourceGroup({
  label,
  sources,
  empty,
  isPicked,
  full,
  disabled,
  onToggle,
}: {
  label: string;
  sources: LearningSourceOption[];
  empty: string;
  isPicked: (source: LearningSourceOption) => boolean;
  full: boolean;
  disabled: boolean;
  onToggle: (source: LearningSourceOption) => void;
}) {
  return (
    <fieldset className="min-w-0 border-border not-first:border-t">
      <legend className="sr-only">{label}</legend>
      <p aria-hidden className="sticky top-0 bg-popover px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
        {label}
      </p>
      {sources.length === 0 ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="pb-1">
          {sources.map((source) => {
            const picked = isPicked(source);
            const notReady = source.type === "document" && !source.ready;
            const blocked = disabled || notReady || (full && !picked);
            return (
              <li key={source.id}>
                <label
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 text-body-dense",
                    blocked ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer hover:bg-muted",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={picked}
                    disabled={blocked && !picked}
                    onChange={() => onToggle(source)}
                    className="size-3.5 shrink-0 accent-[var(--primary)]"
                  />
                  <SourceIcon type={source.type} />
                  <span className="min-w-0 flex-1 truncate">{source.title}</span>
                  {notReady ? <span className="shrink-0 text-xs text-muted-foreground">Still reading</span> : null}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
