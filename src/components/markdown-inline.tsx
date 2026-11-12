import type { ReactNode } from "react";

/*
 * The inline rules shared by the transcript renderer and the artifact body:
 * bold, italic, inline code, links, images, and the 【citation】 chip. Extracted from
 * components/markdown.tsx so the two renderers cannot drift.
 */

// Link must precede bold/italic so `[text](href)` is claimed whole: otherwise
// the `*`-less alternation splits it and the brackets reach the user as text.
const INLINE = /(!\[[^\]\n]*\]\([^)\s]+\)|\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|【[^】\n]+】)/g;

const IMAGE = /^!\[([^\]\n]*)\]\(([^)\s]+)\)$/;
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;

/**
 * Only same-origin paths and http(s) become anchors. A model-written answer is
 * untrusted input, so `javascript:` and `data:` hrefs must never reach an
 * anchor's href — a link the user clicks is the one place a prompt injection
 * turns into an action.
 */
export function safeHref(href: string): string | null {
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (/^https?:\/\//i.test(href)) return href;
  return null;
}

/* eslint-disable @next/next/no-img-element -- Markdown images may use authenticated app URLs and must load directly. */

export function inline(raw: string): ReactNode[] {
  // Models escape pipes in answers; a citation mark like 【Document: Lease】
  // becomes a chip instead of raw brackets.
  const text = raw.replace(/\\\|/g, "|");
  return text.split(INLINE).map((part, i) => {
    const image = IMAGE.exec(part);
    if (image) {
      const [, alt, source] = image;
      const safe = safeHref(source);
      if (safe) {
        return (
          <img
            key={i}
            src={safe}
            alt={alt}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="my-4 max-h-[70vh] max-w-full rounded-xl border border-border bg-muted/30 object-contain shadow-sm"
          />
        );
      }
      return <span key={i}>{alt}</span>;
    }
    const link = LINK.exec(part);
    if (link) {
      const [, label, href] = link;
      const safe = safeHref(href);
      // An anchor must render as something on the first frame: an in-app path
      // is a real anchor, an external one opens away from the thread.
      if (safe) {
        const external = safe.startsWith("http");
        return (
          <a
            key={i}
            href={safe}
            {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
            className="text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
          >
            {label}
          </a>
        );
      }
      return <span key={i}>{label}</span>;
    }
    if (part.startsWith("【") && part.endsWith("】")) {
      return (
        <span
          key={i}
          className="bg-muted text-muted-foreground mx-0.5 inline-block rounded px-1 py-px align-baseline text-data"
        >
          {part.slice(1, -1)}
        </span>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      // A bold span can hold a link (`**[name](url)**`), which must still render as one.
      return <strong key={i}>{inline(part.slice(2, -2))}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="bg-muted rounded px-1 py-0.5 text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{inline(part.slice(1, -1))}</em>;
    }
    return part;
  });
}

/* eslint-enable @next/next/no-img-element */
