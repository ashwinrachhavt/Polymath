"use client";

import { useCallback, useState } from "react";
import { ChatSurface, type ChatSubject } from "@/components/chat/chat-surface";
import { Screen, Status } from "@/components/workspace/ui";
import { startChatRun } from "@/app/(workspace)/apps/alfred/chat-actions";
/*
 * Ask Polymath — the chat screen, mounted on the shared ChatSurface.
 *
 * This screen owns only the part that is unique to it: turning "what am I asking
 * about?" into a run. Everything else (streaming, transcript, composer,
 * citations) is ChatSurface, which is the same component the notebook pane and
 * any future surface mount.
 *
 * A run is created on first send rather than on mount: a visit to the screen
 * that never asks anything must not reserve budget or open an Eve session.
 */
export default function Chat({ initialId }: { initialId?: string }) {
  const [subject, setSubject] = useState<ChatSubject>({ type: "dossier", id: initialId ?? "" });
  const [runId, setRunId] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const begin = useCallback(async () => {
    const objective = message.trim();
    if (!objective || starting) return;
    setStarting(true);
    setError(null);
    try {
      // serves; a conversation without a key would risk a second run on retry.
      const result = await startChatRun({
        objective,
        subject,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setRunId(result.runId);
    } catch {
      setError("The chat could not start. Check the connection and try again.");
    } finally {
      setStarting(false);
    }
  }, [message, starting, subject]);

  return (
    <Screen
      title="Ask Polymath"
      description="Answers cite the passages they use, and consequential actions become proposals rather than happening."
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="panel min-h-[520px] rounded-xl p-5">
          {runId ? (
            <ChatSurface
              runId={runId}
              subject={subject}
              title="Polymath"
              className="h-full"
            />
          ) : (
            <div className="flex h-full flex-col">
              <div className="mb-4 flex flex-wrap gap-2">
                <Status>Agent ready</Status>
                <Status>Citations on</Status>
              </div>
              <form
                className="flex min-h-0 flex-1 flex-col"
                onSubmit={(event) => {
                  event.preventDefault();
                  void begin();
                }}
              >
                <label className="flex flex-col gap-1.5 text-[13px]">
                  <span className="font-medium">Your question</span>
                  <textarea
                    className="min-h-[120px] w-full resize-none rounded-lg border border-border bg-background p-3 text-[13px] leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder="What do these sources support? What is still uncertain?"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                  />
                </label>
                {error && (
                  <p role="alert" className="mt-2 text-[12px] text-destructive">
                    {error}
                  </p>
                )}
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="submit"
                    disabled={!message.trim() || starting}
                    className="inline-flex min-h-9 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {starting ? "Starting" : "Start the conversation"}
                  </button>
                  <p className="text-[11px] text-muted-foreground">
                    A run starts when you send, and reserves budget first.
                  </p>
                </div>
              </form>
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <div className="panel rounded-xl p-4">
            <p className="text-[13px] font-medium">Context</p>
            <label className="mt-2 flex flex-col gap-1.5 text-[12px]">
              <span className="text-muted-foreground">Ask about</span>
              <select
                className="min-h-9 rounded-md border border-border bg-background px-2 text-[13px]"
                value={subject.type}
                onChange={(event) => setSubject({ ...subject, type: event.target.value as ChatSubject["type"] })}
              >
                <option value="dossier">A dossier</option>
                <option value="document">A document</option>
                <option value="artifact">An artifact</option>
              </select>
            </label>
            <label className="mt-3 flex flex-col gap-1.5 text-[12px]">
              <span className="text-muted-foreground">Record id</span>
              <input
                className="min-h-9 rounded-md border border-border bg-background px-2 font-mono text-[12px]"
                value={subject.id}
                onChange={(event) => setSubject({ ...subject, id: event.target.value })}
              />
            </label>
          </div>
          <div className="panel rounded-xl p-4">
            <p className="text-[13px] font-medium">What this can do</p>
            <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-muted-foreground">
              <li>Search the workspace&apos;s documents and cite the passages it used.</li>
              <li>Read a connected service when the run&apos;s policy allows it.</li>
              <li>Propose sends, writes, and deploys for your review. It never performs them.</li>
            </ul>
          </div>
        </aside>
      </div>
    </Screen>
  );
}
