"use client";

import { useCallback, useState } from "react";
import { SessionRail } from "./session-rail";
import { WritingSurface } from "./writing-surface";
import { AmbientPanel } from "./ambient-panel";
import { ActionTasksSidebar } from "./action-tasks-sidebar";
import { initialStreamState, type StreamState } from "./creation-stream-reducer";

/*
 * The WorkspaceShell (§7): SessionRail | WritingSurface |
 * AmbientIntelligencePanel. The rail lists the sitting's cards, the surface
 * owns the writing, the panel mirrors the stream state. There is no
 * lifecycle (Gate 2026-10-29): no End action, no closing summary - the
 * workspace is always there, revisitable and writable at any time.
 */
export function WorkspaceShell({
  workspaceId,
  sitting,
  initialCards,
  source,
}: {
  workspaceId: string;
  /** §14.10: seeded sittings show a "From: {document}" chip, openable for reference. */
  source: { title: string; href: string } | null;
  sitting: { id: string; topic: string | null; tags: string[]; startedAt: string };
  initialCards: { artifactId: string; role: string; position: number }[];
}) {
  const [cards, setCards] = useState(initialCards);
  const [streamState, setStreamState] = useState<StreamState>(() => initialStreamState(sitting.id));

  const onCardSaved = useCallback((artifactId: string) => {
    setCards((prev) => prev.some((c) => c.artifactId === artifactId)
      ? prev
      : [...prev, { artifactId, role: "created_here", position: prev.length }]);
  }, []);

  const retryStage = useCallback(() => {
    // A retry is a fresh pause firing the run's stages again: the run's
    // version guard skips what already succeeded (§15.3 retry re-runs the
    // skipped stage).
    setStreamState((prev) => ({ ...prev, done: false }));
  }, []);

  return (
    <div className="flex h-full min-h-0">
      <SessionRail topic={sitting.topic} cards={cards} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-6 py-2">
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            Sitting
            {source && (
              <a href={source.href} className="rounded-full border border-border px-2 py-0.5 text-xs underline-offset-2 hover:underline">
                From: {source.title}
              </a>
            )}
          </span>
        </header>
        <WritingSurface
          workspaceId={workspaceId}
          sittingId={sitting.id}
          seededFromDocument={source !== null}
          onStreamState={setStreamState}
          onCardSaved={onCardSaved}
        />
      </div>
      <div className="flex shrink-0 flex-col overflow-y-auto max-lg:border-t">
        <AmbientPanel state={streamState} onRetryStage={retryStage} />
        <ActionTasksSidebar
          sittingId={sitting.id}
          refreshKey={`${cards.length}-${streamState.stages["links"]?.status ?? "idle"}-${streamState.done}`}
        />
      </div>
    </div>
  );
}
