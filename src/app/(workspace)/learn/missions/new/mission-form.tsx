"use client";

import { FileText, Inbox, Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { WorkStatus } from "@/components/work-status";
import type { LearningSourceOption } from "../../make-actions";
import { createMissionAction, type MissionSourceRef } from "../../mission-actions";

/*
 * One screen: what you must be able to do, by when, and what to study from.
 * Submit returns at once; the concept list is made in the background and the
 * Mission page shows the wait. Nothing blocks on a model call.
 */

type Found = { documents: LearningSourceOption[]; captures: LearningSourceOption[] };

export function MissionForm({ initialSources }: { initialSources: LearningSourceOption[] }) {
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const [role, setRole] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [selected, setSelected] = useState<LearningSourceOption[]>(initialSources.slice(0, 8));
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // A resend after a failed request replays its key; a successful submit clears it.
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    let stale = false;
    const timer = setTimeout(
      () => {
        void import("../../make-actions").then(({ findLearningSourcesAction }) =>
          findLearningSourcesAction({ query }).then(
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
          ),
        );
      },
      query ? 200 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);

  const problem =
    goal.trim().length === 0
      ? "Say in one sentence what you need to be able to do."
      : selected.length === 0
        ? "Pick at least one source."
        : null;

  function toggle(source: LearningSourceOption) {
    setError(null);
    setSelected((current) =>
      current.some((item) => item.type === source.type && item.id === source.id)
        ? current.filter((item) => !(item.type === source.type && item.id === source.id))
        : [...current, source],
    );
  }

  function submit() {
    if (problem || pending) return;
    setError(null);
    const sources: MissionSourceRef[] = selected.map((source) =>
      source.type === "document"
        ? { type: "document", id: source.id }
        : { type: "capture", id: source.id, version: source.version },
    );
    const signature = JSON.stringify([goal.trim(), role.trim(), dueOn, sources]);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    const idempotencyKey = attempt.current.key;
    startTransition(async () => {
      const result = await createMissionAction({
        goal: goal.trim(),
        role: role.trim() || undefined,
        dueOn: dueOn || null,
        sources,
        idempotencyKey,
      }).catch(() => ({ ok: false as const, error: "The request did not reach Polymath. Try again." }));
      attempt.current = null;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // The Mission page shows the wait and the plan; a full navigation resets this form.
      router.push(`/learn/missions/${result.missionId}`);
    });
  }

  return (
    <section className="panel rounded-xl p-4">
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-body-dense font-medium">What do you need to be able to do?</span>
          <Textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Explain how a database transaction commits, unaided, on a whiteboard."
            aria-label="What do you need to be able to do"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-body-dense font-medium">
              By when? <span className="text-xs font-normal text-muted-foreground">Optional</span>
            </span>
            <Input type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} aria-label="By when" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-body-dense font-medium">
              The role or interview <span className="text-xs font-normal text-muted-foreground">Optional</span>
            </span>
            <Input
              value={role}
              onChange={(event) => setRole(event.target.value)}
              maxLength={2000}
              placeholder="Senior backend engineer at a payments company"
              aria-label="The role or interview"
            />
          </label>
        </div>

        <section aria-label="Sources" className="flex flex-col gap-2">
          <p className="text-body-dense font-medium">What should it be built from?</p>
          {selected.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {selected.map((source) => (
                <li
                  key={source.type + source.id}
                  className="flex max-w-full items-center gap-1 rounded-md border bg-muted/50 py-0.5 pr-0.5 pl-2 text-xs"
                >
                  {source.type === "document" ? (
                    <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Inbox aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="max-w-56 truncate">{source.title}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${source.title}`}
                    disabled={pending}
                    onClick={() => toggle(source)}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
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
          ) : found.documents.length === 0 && found.captures.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {query
                ? "No sources match that search."
                : "Your library and inbox are empty. Add a source first, then come back."}
            </p>
          ) : (
            <div className="max-h-56 overflow-y-auto rounded-md border border-border">
              {found.documents.length > 0 ? (
                <SourceGroup label="Library" sources={found.documents} selected={selected} onToggle={toggle} />
              ) : null}
              {found.captures.length > 0 ? (
                <SourceGroup label="Inbox" sources={found.captures} selected={selected} onToggle={toggle} />
              ) : null}
            </div>
          )}
        </section>

        {error ? <WorkStatus state={{ phase: "failed", label: error }} /> : null}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{problem}</p>
          <Button disabled={pending || problem !== null} onClick={submit}>
            {pending ? "Starting…" : "Find my concepts"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          You will review the concepts before anything starts.{" "}
          <Link href="/learn" className="underline underline-offset-4">
            Back to Learn
          </Link>
        </p>
      </div>
    </section>
  );
}

function SourceGroup({
  label,
  sources,
  selected,
  onToggle,
}: {
  label: string;
  sources: LearningSourceOption[];
  selected: LearningSourceOption[];
  onToggle: (source: LearningSourceOption) => void;
}) {
  const isPicked = (source: LearningSourceOption) =>
    selected.some((item) => item.type === source.type && item.id === source.id);
  return (
    <fieldset className="min-w-0 border-border not-first:border-t">
      <legend className="sr-only">{label}</legend>
      <p aria-hidden className="sticky top-0 bg-popover px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
        {label}
      </p>
      <ul className="pb-1">
        {sources.map((source) => {
          const picked = isPicked(source);
          const notReady = source.type === "document" && !source.ready;
          return (
            <li key={source.id}>
              <label
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 text-body-dense",
                  notReady ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer hover:bg-muted",
                )}
                title={notReady ? "Still being read; it can be a source once reading finishes." : undefined}
              >
                <input
                  type="checkbox"
                  checked={picked}
                  disabled={notReady}
                  onChange={() => onToggle(source)}
                  className="size-3.5"
                />
                <span className="truncate">{source.title}</span>
                {notReady ? <span className="ml-auto text-xs">Reading…</span> : null}
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
