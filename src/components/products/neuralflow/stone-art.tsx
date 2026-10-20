"use client";

import Image from "next/image";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import type { Task, WorkspaceState } from "@/components/workspace/types";
import { stoneForReward, stoneReason, type Stone } from "./stones";
import "./neuralflow-stones.css";

export function StoneArt({ stone, size, locked = false, sheen = false, decorative = true, className }: { stone: Stone; size: number; locked?: boolean; sheen?: boolean; decorative?: boolean; className?: string }) {
  // Size is a per-use dimension, not a design token.
  return <span className={cn("nf-vitrine", locked && "nf-locked", sheen && "nf-sheen", className)} style={{ width: size, height: size }}>
    <Image src={stone.image} alt={decorative ? "" : `${stone.name}${locked ? ", locked" : ""}`} width={size * 2} height={size * 2} sizes={`${size}px`} />
  </span>;
}


/*
 * The Opal-style stage (ASH-175): the stone alone on a dark field with a soft
 * halo and a small pedestal, a small-caps caption, and one large readout
 * under it. Used wherever a single stone is the hero - the focus timer and
 * the session reveal. `sub` is a node so the caller can keep the timer's
 * role and aria-label on the readout.
 */
export function StoneStage({ caption, sub, children, className }: { caption?: string; sub?: ReactNode; children?: ReactNode; className?: string }) {
  return <div className={cn("nf-stage", className)}>
    <span className="nf-stage-glow" aria-hidden />
    {children ? <div className="flex flex-col items-center">{children}<span className="nf-stage-pedestal" aria-hidden /></div> : null}
    {caption ? <p className="nf-stage-caption">{caption}</p> : null}
    {sub ? <div className="nf-stage-sub readout">{sub}</div> : null}
  </div>;
}

/* The crystal greys out at the start of an interval and lights up as it elapses. */
export function FormingStone({ stone, progress, reduceMotion }: { stone: Stone; progress: number; reduceMotion: boolean }) {
  const formed = { "--nf-forming": progress } as CSSProperties;
  return <span className="nf-vitrine nf-forming" style={formed} data-motion={reduceMotion ? "reduce" : "full"} aria-hidden>
    <Image className="nf-forming-base" src={stone.image} alt="" width={112} height={112} sizes="56px" />
    <Image className="nf-forming-lit" src={stone.image} alt="" width={112} height={112} sizes="56px" />
  </span>;
}

/*
 * Closes a focus session without blocking the screen. The stone appears only
 * when this save added a ledger entry; it turns in once when celebrations are
 * on and motion is allowed, and sits still otherwise.
 */
export function SessionComplete({ completed, taskDone, stone, reason, earnedTotal, animate, onRestart, onDismiss }: { completed: boolean; taskDone: boolean; stone?: Stone; reason?: string; earnedTotal: number; animate: boolean; onRestart?: () => void; onDismiss: () => void }) {
  const heading = !completed ? "Session ended early. The task is still open." : taskDone ? "The session is complete, and so is the task." : "The session is complete. The task is not.";
  return <section aria-labelledby="nf-session-complete" className="panel flex flex-col gap-4 rounded-xl p-4 sm:flex-row sm:items-center">
    {stone && <div className="nf-stage self-center px-6 py-5" aria-hidden>
      <span className="nf-stage-glow" aria-hidden />
      <div className={cn("nf-reveal", animate && "nf-animate")}>
        <span className="nf-halo" />
        <span className="nf-ring" />
        {Array.from({ length: 8 }, (_, index) => <span key={index} className="nf-shard" />)}
        <StoneArt stone={stone} size={80} className="nf-reveal-stone" />
      </div>
      <span className="nf-stage-pedestal" aria-hidden />
    </div>}
    <div className="min-w-0 flex-1">
      <h2 id="nf-session-complete" className="text-[13px] font-medium">{heading}</h2>
      {stone ? <>
        <h3 className="mt-2 text-[13px]">Clarity stone earned</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{stone.name}. {reason} One stone per recorded interval; saving again cannot add another. <span className="readout">{earnedTotal}</span> in your local collection.</p>
      </> : <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{completed ? "Your outcome is recorded." : "Early endings are recorded without a stone. Nothing was taken away."}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {onRestart && <Button size="sm" onClick={onRestart}>Start another interval</Button>}
        {stone && <Button size="sm" variant="outline" asChild><Link href="/apps/neuralflow/rewards">View stone collection</Link></Button>}
        <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
      </div>
    </div>
  </section>;
}

/*
 * A compact, read-only shelf of the most recent earned stones, each with the
 * reason it was earned. Pure presentation: the caller passes the ledger and
 * the tasks it can name.
 */
export function StoneShelf({ rewards, tasks, limit = 5, className }: { rewards: WorkspaceState["rewards"]; tasks: Pick<Task, "id" | "title">[]; limit?: number; className?: string }) {
  const recent = [...rewards].sort((a, b) => b.earnedAt.localeCompare(a.earnedAt)).slice(0, limit);
  return <div className={cn("flex flex-col gap-2", className)}>
    {recent.length ? <ul className="divide-y divide-border">{recent.map((reward) => {
      const stone = stoneForReward(reward.title);
      return <li key={reward.id} className="flex items-center gap-3 py-2">
        {stone ? <StoneArt stone={stone} size={32} /> : <span className="nf-vitrine size-8" aria-hidden />}
        <div className="min-w-0 flex-1"><p className="text-[13px] font-medium">{reward.title}</p><p className="truncate text-xs text-muted-foreground">{stoneReason(reward, tasks)}</p></div>
        <time dateTime={reward.earnedAt} className="readout shrink-0 text-xs text-muted-foreground">{new Date(reward.earnedAt).toLocaleDateString()}</time>
      </li>;
    })}</ul> : <p className="text-xs text-muted-foreground">No stones yet. Record a completed focus interval to earn one.</p>}
    <Link href="/apps/neuralflow/rewards" className="text-xs underline underline-offset-4">Open stone collection</Link>
  </div>;
}
