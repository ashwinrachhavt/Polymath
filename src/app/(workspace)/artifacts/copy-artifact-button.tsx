"use client";

import { useState } from "react";
import { Copy } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";

/*
 * Copies the artifact's markdown to the clipboard. The toolbar used to show
 * a decorative Copy icon wired to nothing; a control that does nothing is
 * worse than none, so this is the real one. On a design brief it doubles as
 * the honest interim handoff: paste the brief into Canva (or anywhere)
 * until an executable transfer route lands (ASH-286).
 */
export function CopyArtifactButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <span className="flex items-center gap-1.5">
      {copied ? (
        <span role="status" className="text-muted-foreground">
          Copied
        </span>
      ) : null}
      {failed ? (
        <span role="alert" className="text-destructive">
          Copy failed
        </span>
      ) : null}
      <IconButton
        label="Copy artifact markdown"
        icon={<Copy aria-hidden />}
        onClick={async () => {
          setCopied(false);
          setFailed(false);
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          } catch {
            setFailed(true);
          }
        }}
      />
    </span>
  );
}
