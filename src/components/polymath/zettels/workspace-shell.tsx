"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { SessionRail } from "./session-rail";
import { WritingSurface } from "./writing-surface";
import { AmbientPanel } from "./ambient-panel";
import { initialStreamState, type StreamState } from "./creation-stream-reducer";
import { endSittingAction } from "@/app/(workspace)/polymath/knowledge/zettels/session/actions";

/*
 * The WorkspaceShell (§7): SessionRail | WritingSurface |
 * AmbientIntelligencePanel. The rail lists the sitting's cards, the surface
 * owns the writing, the panel mirrors the stream state. §14.5: End sitting
 * asks once, then the sitting becomes a record.
 */
export function WorkspaceShell({
  workspaceId,
  sitting,
  initialCards,
}: {
  workspaceId: string;
  sitting: { id: string; topic: string | null; tags: string[]; startedAt: string; endedAt: string | null };
  initialCards: { artifactId: string; role: string; position: number }[];
}) {
  const router = useRouter();
  const [cards, setCards] = useState(initialCards);
  const [streamState, setStreamState] = useState<StreamState>(() => initialStreamState(sitting.id));
  const [confirmingEnd, setConfirmingEnd] = useState(false);

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

  const endSitting = useCallback(async () => {
    setConfirmingEnd(false);
    await endSittingAction({ sittingId: sitting.id });
    router.push("/polymath/knowledge/zettels");
  }, [router, sitting.id]);

  const ended = sitting.endedAt !== null;
  return (
    <div className="flex h-full min-h-0">
      <SessionRail topic={sitting.topic} cards={cards} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-6 py-2">
          <span className="text-sm text-muted-foreground">
            {ended ? "Ended sitting (browse only)" : "Sitting in progress"}
          </span>
          {!ended && (
            confirmingEnd ? (
              <span className="flex items-center gap-2 text-sm">
                End this sitting?
                <button className="rounded bg-primary px-2 py-1 text-primary-foreground" onClick={() => void endSitting()}>End sitting</button>
                <button className="underline" onClick={() => setConfirmingEnd(false)}>Keep writing</button>
              </span>
            ) : (
              <button className="text-sm underline" onClick={() => setConfirmingEnd(true)}>End sitting</button>
            )
          )}
        </header>
        {ended ? (
          <p className="px-6 py-4 text-sm text-muted-foreground">Ended sittings are records. This sitting is read-only.</p>
        ) : (
          <WritingSurface
            workspaceId={workspaceId}
            sittingId={sitting.id}
            onStreamState={setStreamState}
            onCardSaved={onCardSaved}
          />
        )}
      </div>
      <AmbientPanel state={streamState} onRetryStage={retryStage} />
    </div>
  );
}
