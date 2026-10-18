"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "cn";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { StoneArt } from "@/components/products/neuralflow/stone-art";
import { stoneForReward } from "@/components/products/neuralflow/stones";
import { loopBeats, nextBeat } from "./loop-story";
import "./loop-story.css";

export function LoopStoryStrip({ today }: { today: string }) {
  const { state } = useWorkspace();
  const [ready, setReady] = useState(false);
  useEffect(() => { const frame = requestAnimationFrame(() => setReady(true)); return () => cancelAnimationFrame(frame); }, []);
  const beats = loopBeats(state, today);
  const next = nextBeat(beats);
  const nextIndex = beats.findIndex((beat) => beat.key === next);
  const latest = state.rewards.at(-1);
  const stone = latest ? stoneForReward(latest.title) : undefined;

  return <nav aria-label="Your loop today" className={cn("loop-strip", state.preferences.reducedMotion && "loop-calm")} data-ready={ready}>
    {beats.map((beat, index) => {
      const isNext = beat.key === next;
      return <Link key={beat.key} href={beat.href} data-app={beat.app} data-next={isNext} data-passed={nextIndex > index} aria-current={isNext ? "step" : undefined} aria-label={`${beat.label}${isNext ? ", your next step" : ""}: ${beat.count} ${beat.unit}. ${beat.action}`}
        className={cn("loop-beat", isNext && "loop-next")} style={{ "--i": index } as React.CSSProperties}>
        <span className={"loop-label"}><span className={"loop-step"}>{index + 1}</span>{beat.label}{isNext && <span className={"loop-pulse"} aria-hidden />}</span>
        <span className="flex items-baseline gap-1.5"><span className={"loop-count"}>{beat.count}</span><span className={"loop-unit"}>{beat.unit}</span></span>
        {beat.key === "learn" && stone && <StoneArt stone={stone} size={28} className={"loop-stone"} />}
        <span className={"loop-reason"}>{beat.reason}</span>
        <span className={"loop-action"}>{beat.action}</span>
      </Link>;
    })}
  </nav>;
}
