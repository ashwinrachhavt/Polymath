import type { ReactNode } from "react";

/*
 * The inline rules shared by the transcript renderer and the artifact body:
 * bold, italic, inline code, and the 【citation】 chip. Extracted from
 * components/markdown.tsx so the two renderers cannot drift.
 */

const INLINE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|【[^】\n]+】)/g;

export function inline(raw: string): ReactNode[] {
  // Models escape pipes in answers; a citation mark like 【Document: Lease】
  // becomes a chip instead of raw brackets.
  const text = raw.replace(/\\\|/g, "|");
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("【") && part.endsWith("】")) {
      return (
        <span key={i} className="bg-muted text-muted-foreground mx-0.5 inline-block rounded px-1 py-px align-baseline text-[11px]">
          {part.slice(1, -1)}
        </span>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={i} className="bg-muted rounded px-1 py-0.5 text-[0.85em]">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}
