"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { captureTextAction } from "./actions";

/* The list pane's composer: one line collapsed, textarea on focus (D6/D8).
   After capture the page navigates to ?id=<new capture> so the detail pane
   shows what was just captured — the immediate "did that work" confirmation. */

export function CaptureForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const collapsed = !expanded && !text;

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await captureTextAction({ text });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setText("");
          setExpanded(false);
          router.push(`/command-center/inbox?id=${result.id}`);
        });
      }}
    >
      {collapsed ? (
        <input
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => setExpanded(true)}
          placeholder="Capture a thought, excerpt, or URL…"
          aria-label="Capture a thought, excerpt, or URL"
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-[13px] transition-opacity duration-150 placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        />
      ) : (
        <>
          <Textarea
            required
            maxLength={20000}
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={(event) => {
              if (!event.target.value.trim()) setExpanded(false);
            }}
            placeholder="Paste a thought, source excerpt, or URL"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending || !text.trim()}>
              {pending ? "Capturing…" : "Capture to inbox"}
            </Button>
            {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
          </div>
        </>
      )}
    </form>
  );
}
