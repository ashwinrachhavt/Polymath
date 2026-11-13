"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Archive, GraduationCap, Sparkles, Target, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";

/*
 * The notebook's right rail, in the manner of a Perplexity Space: everything
 * you can make or practise from this notebook's sources, one click away, in
 * four segments instead of a stack of panels.
 *
 *   Create    reports, slide decks and infographics from a brief
 *   Learn     quiz, flashcards and Explain It, and what they made
 *   Practice  Predict and Bug Hunt
 *   Library   runs awaiting review, and what this notebook has produced
 *
 * Alt+1 to Alt+4 jump between segments from anywhere on the page; the
 * segment's tooltip names its key. A dot on Learn or Practice says work is in
 * flight, so a closed segment never hides a running job.
 *
 * The same rail is the body of the sheet on a phone (notebook-surface.tsx), so
 * the two cannot drift apart.
 */

export type StudioSegment = "create" | "learn" | "practice" | "library";

const SEGMENTS: { id: StudioSegment; label: string; icon: LucideIcon; key: string }[] = [
  { id: "create", label: "Create", icon: Sparkles, key: "1" },
  { id: "learn", label: "Learn", icon: GraduationCap, key: "2" },
  { id: "practice", label: "Practice", icon: Target, key: "3" },
  { id: "library", label: "Library", icon: Archive, key: "4" },
];

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    (target.matches("input, textarea, select") ||
      target.closest("[contenteditable]:not([contenteditable='false'])") !== null)
  );
}

export function StudioRail({
  panels,
  busy = {},
  initial = "create",
  className,
}: {
  panels: Record<StudioSegment, ReactNode>;
  /** The segment shown first, e.g. Learn when a link opened a quiz. */
  initial?: StudioSegment;
  /** Segments with work in flight, shown as a dot on the segment. */
  busy?: Partial<Record<StudioSegment, boolean>>;
  className?: string;
}) {
  const [segment, setSegment] = useState<StudioSegment>(initial);

  // Alt+1..4. Matched on the physical key, because Option+digit types a symbol on a Mac.
  // The rail inside a closed sheet is not mounted, so only the visible rail listens.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const match = SEGMENTS.find((entry) => event.code === `Digit${entry.key}`);
      if (!match || isTypingTarget(event.target)) return;
      event.preventDefault();
      setSegment(match.id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <Tabs
      value={segment}
      onValueChange={(next) => setSegment(next as StudioSegment)}
      className={cn("gap-3", className)}
    >
      <TabsList aria-label="Studio" className="w-full">
        {SEGMENTS.map(({ id, label, icon: Icon, key }) => (
          <Tooltip key={id} content={label} shortcut={`⌥${key}`} side="bottom">
            <TabsTrigger value={id} aria-keyshortcuts={`Alt+${key}`} className="relative">
              <Icon aria-hidden />
              <span>{label}</span>
              {busy[id] ? (
                <>
                  <span aria-hidden className="bg-app-accent absolute top-1 right-1 size-1.5 rounded-full" />
                  <span className="sr-only">, working</span>
                </>
              ) : null}
            </TabsTrigger>
          </Tooltip>
        ))}
      </TabsList>
      {SEGMENTS.map(({ id }) => (
        <TabsContent key={id} value={id} className="flex flex-col gap-3">
          {panels[id]}
        </TabsContent>
      ))}
    </Tabs>
  );
}
