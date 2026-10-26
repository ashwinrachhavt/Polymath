"use client";

import { ChatSurface, type ChatSubject } from "./chat-surface";

/*
 * An in-place conversation: the run mounts here, on the page that started it,
 * instead of navigating to a route. Both the Assistant home and a project
 * page mount this the moment their run id exists; the typed message crosses
 * as the optimistic one until the stream echoes it.
 *
 * `onContinue` is passed through for the surfaces that own conversation
 * continuity. A surface that does not supply it keeps the plain follow-up
 * behaviour, where a finished run is simply finished.
 */
export function InPlaceChat({
  runId,
  subject,
  optimisticMessage,
  onContinue,
  className,
}: {
  runId: string;
  subject: ChatSubject;
  optimisticMessage?: string;
  onContinue?: (runId: string, text: string) => Promise<{ ok: true; runId: string } | { ok: false; message: string }>;
  className?: string;
}) {
  return (
    <div className={className ?? "flex h-[min(72dvh,720px)] flex-col"}>
      <ChatSurface
        runId={runId}
        subject={subject}
        optimisticMessage={optimisticMessage}
        {...(onContinue ? { onContinue } : {})}
        placeholder="Reply to continue…"
        composerLabel="Follow-up message"
        emptyText="This conversation has no messages yet."
        showHeader={false}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
