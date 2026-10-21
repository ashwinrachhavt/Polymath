"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { startChatRun } from "@/app/(workspace)/apps/alfred/chat-actions";

/*
 * The one mutation on the home screen: a sentence becomes a run.
 *
 * The page has no record in hand, so the run carries no subject. `engine.start`
 * stores `subjects` verbatim and the column defaults to `[]`, which is the
 * honest value for a conversation that is not about a specific artifact.
 *
 * Idempotency is the island's, not the action's: `startChatRun` claims no
 * receipt (see its own comment), so the only available guard is one in-flight
 * submit at a time. A key generated here would be dropped on the floor by the
 * server, so none is generated; the pending flag is the whole guard, and it is
 * cleared in `finally` so a failed start cannot leave the composer stuck.
 *
 * A failed start keeps the draft. Losing typed text on a send that did not
 * happen is the worst failure this screen can produce.
 */
export function NewConversation() {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const objective = draft.trim();
    if (!objective || pending) return;

    /*
     * The conversation opens in place, before the run exists. Waiting for the
     * server action and then pushing a route meant a keystroke vanished behind a
     * transaction, a session create, and a full navigation — which reads as lag
     * even when every part is fast. `router.push` still runs, but only after the
     * run id is known, and the route it lands on shows this same turn.
     */
    setPending(true);
    setError(null);
    try {
      const result = await startChatRun({ objective });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // `replace`, not `push`: the empty home is not somewhere to go back to,
      // and the new conversation is already the thing being viewed.
      router.replace(`/alfred/${result.runId}`);
    } catch {
      setError("The conversation could not start. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="mx-auto flex w-full max-w-2xl flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="panel relative rounded-xl has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50">
        <Textarea
          autoFocus
          aria-label="Start a conversation"
          className="min-h-[88px] resize-none border-0 bg-transparent pr-12 text-[13px] leading-6 focus-visible:ring-0"
          placeholder="Ask anything or describe a task…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Button
          type="submit"
          size="icon-sm"
          aria-label="Send"
          disabled={!draft.trim() || pending}
          className="absolute right-2 bottom-2"
        >
          <ArrowUp aria-hidden />
        </Button>
      </div>
      {error ? (
        <p role="status" className="text-destructive mt-2 text-[12px]">
          {error}
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="text-muted-foreground mt-2 text-[12px]">
          Starting…
        </p>
      ) : null}
    </form>
  );
}
