"use client";

import { CornerDownLeft, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { captureTextAction } from "./actions";

/*
 * The list pane's composer: a one-line command bar that opens into a textarea
 * on focus (D6/D8). It sits in the list column header, not under a page
 * heading, so capturing costs one line of vertical space. After capture the
 * page navigates to ?id=<new capture> so the detail pane shows what was just
 * captured, the immediate "did that work" confirmation.
 */

export function CaptureForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<{ message: string; existingId?: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const collapsed = !expanded && !text;

  function submit() {
    setError(null);
    if (!text.trim()) return;
    startTransition(async () => {
      const result = await captureTextAction({ text });
      if (!result.ok) {
        setError({ message: result.error, existingId: result.existingId });
        return;
      }
      setText("");
      setExpanded(false);
      router.push(`/command-center/inbox?id=${result.id}`);
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {collapsed ? (
        <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-card px-2.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
          <Plus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onFocus={() => setExpanded(true)}
            placeholder="Capture a thought, excerpt, or URL"
            aria-label="Capture a thought, excerpt, or URL"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>
      ) : (
        <div className="rounded-md border border-input bg-card p-2 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
          <Textarea
            required
            maxLength={20000}
            autoFocus
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={(event) => {
              if (!event.target.value.trim()) setExpanded(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Paste a thought, source excerpt, or URL"
            aria-label="Capture a thought, excerpt, or URL"
            className="min-h-16 resize-none border-0 bg-transparent p-1 text-[13px] shadow-none focus-visible:ring-0"
          />
          <div className="flex flex-wrap items-center gap-2 border-border border-t px-1 pt-2">
            <Button type="submit" size="sm" disabled={pending || !text.trim()}>
              {pending ? "Capturing…" : "Capture to inbox"}
            </Button>
            <button
              type="button"
              onClick={() => {
                setText("");
                setExpanded(false);
                setError(null);
              }}
              className="rounded px-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Cancel
            </button>
            <span className="ml-auto hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
              <CornerDownLeft aria-hidden className="size-3" />
              <span className="readout">Cmd Enter</span>
            </span>
            {error ? (
              <p className="w-full text-destructive text-[13px]" role="alert">
                {error.message}
                {error.existingId ? (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="underline underline-offset-2 hover:text-foreground"
                      onClick={() => {
                        setText("");
                        setExpanded(false);
                        setError(null);
                        router.push(`/command-center/inbox?id=${error.existingId}`);
                      }}
                    >
                      Open the one you already have
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </form>
  );
}
