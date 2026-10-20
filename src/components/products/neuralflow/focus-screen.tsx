"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Pause, Play, RotateCcw, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Empty, Field, Panel, Screen, Stat, Status } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { focusRemaining, focusRewardKey } from "./planning";
import { FormingStone, SessionComplete, StoneStage } from "./stone-art";
import { formingProgress, stoneForReward, stoneReason } from "./stones";

const clarityStone = stoneForReward("Clarity stone");

export function FocusScreen({ initialTask }: { initialTask?: string }) {
  const { state, getSnapshot, updateFocus, updateTask, addArtifact, updateArtifact, awardReward, notify } = useWorkspace();
  const eligible = state.tasks.filter((task) => task.status !== "DONE");
  const [taskId, setTaskId] = useState(initialTask || "");
  const [mode, setMode] = useState("focus");
  const [minutes, setMinutes] = useState(25);
  const [now, setNow] = useState(0);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [finished, setFinished] = useState<{ sessionId: string; taskId: string; completed: boolean; taskDone: boolean; stoneEarned: boolean; animate: boolean } | null>(null);
  const focus = state.focus;
  const remaining = focus ? focusRemaining(focus, now) : minutes * 60;
  const isBreak = focus?.taskId === "neuralflow-break";
  const task = state.tasks.find((item) => item.id === (focus?.taskId || taskId));
  const chosenTask = taskId || eligible[0]?.id || "";
  const elapsed = focus ? focus.duration * 60 - remaining : 0;
  const finishedReward = finished ? state.rewards.find((reward) => reward.sessionId === finished.sessionId) : undefined;

  useEffect(() => {
    const interval = setInterval(() => {
      const time = Date.now(); setNow(time);
      const current = getSnapshot().focus;
      if (current?.status === "running" && focusRemaining(current, time) === 0) updateFocus({ ...current, status: "paused", remaining: 0 });
    }, 500);
    return () => clearInterval(interval);
  }, [getSnapshot, updateFocus]);

  function start(restartTask?: string) {
    if (getSnapshot().focus) { notify("A session is already active. Resume, reset, or record its outcome before starting another."); return; }
    const intervalMode = restartTask ? "focus" : mode;
    const taskToFocus = restartTask ?? chosenTask;
    const selectedTask = state.tasks.find((item) => item.id === taskToFocus);
    if (intervalMode === "focus" && (!selectedTask || selectedTask.status === "DONE")) { notify("Choose an active canonical task before starting focus."); return; }
    if (intervalMode === "focus" && selectedTask) updateTask(selectedTask.id, { status: "IN_PROGRESS" });
    if (restartTask) { setTaskId(restartTask); setMode("focus"); }
    const timestamp = Date.now(); setNow(timestamp); setFinished(null);
    updateFocus({ taskId: intervalMode === "focus" ? taskToFocus : "neuralflow-break", startedAt: timestamp, remaining: minutes * 60, duration: minutes, status: "running", completed: state.rewards.length });
  }
  function toggle() {
    const current = getSnapshot().focus;
    if (!current) { start(); return; }
    const time = Date.now(); const left = focusRemaining(current, time);
    if (!left) { setOutcomeOpen(true); return; }
    updateFocus({ ...current, status: current.status === "running" ? "paused" : "running", remaining: left, startedAt: time }); setNow(time);
  }
  function reset() {
    const current = getSnapshot().focus; if (!current) return;
    const time = Date.now(); updateFocus({ ...current, startedAt: time, remaining: current.duration * 60, status: "paused" }); setNow(time); setResetOpen(false); notify("Session reset and paused. No reward was granted.");
  }
  function recordOutcome(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = getSnapshot().focus;
    if (!focus || !current || focusRewardKey(current) !== focusRewardKey(focus)) { notify("The session changed. Reopen its outcome before saving."); setOutcomeOpen(false); return; }
    const data = new FormData(event.currentTarget);
    const completed = focusRemaining(current, Date.now()) === 0;
    const outcome = String(data.get("outcome") || "").trim(); const next = String(data.get("next") || "").trim();
    const sessionId = focusRewardKey(current);
    if (current.taskId !== "neuralflow-break") {
      if ((outcome || next) && !getSnapshot().artifacts.some((artifact) => artifact.tags.includes(sessionId))) {
        const note = addArtifact(`Focus reflection: ${task?.title || "Task"}`, "note", `${completed ? "Completed focus interval" : "Ended early"}\n\nOutcome\n${outcome || "No reflection entered."}\n\nNext step\n${next || "Not recorded."}`);
        if (note) updateArtifact(note.id, { links: [current.taskId], tags: ["Focus reflection", sessionId] });
      }
      if (data.get("done")) updateTask(current.taskId, { status: "DONE" });
      // The stone follows the ledger: it shows only when this save added the entry.
      const hadReward = getSnapshot().rewards.some((reward) => reward.sessionId === sessionId);
      if (completed) awardReward({ title: "Clarity stone", earnedAt: new Date().toISOString(), sessionId });
      const snapshot = getSnapshot();
      const stoneEarned = completed && !hadReward && snapshot.rewards.some((reward) => reward.sessionId === sessionId);
      setFinished({ sessionId, taskId: current.taskId, completed, taskDone: !!data.get("done"), stoneEarned, animate: stoneEarned && snapshot.preferences.celebrations && !snapshot.preferences.reducedMotion });
    }
    updateFocus(null); setOutcomeOpen(false);
    notify(current.taskId === "neuralflow-break" ? "Break ended locally. Breaks do not earn focus stones." : completed ? "Focus interval recorded locally. One clarity stone was added for this session." : "Early outcome recorded locally. No completion reward was granted.");
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat || outcomeOpen || resetOpen || document.querySelector('[role="dialog"]')) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input,textarea,select,button,a,[contenteditable=true]")) return;
      if (event.code === "Space") { event.preventDefault(); toggle(); }
      if (event.key.toLowerCase() === "r" && getSnapshot().focus) { event.preventDefault(); setResetOpen(true); }
    }
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  });

  return <Screen title="Focus" description="One task, one interval. This browser-only preview keeps the timer across navigation and refresh using timestamps, not production session storage. Reflection is optional; finishing an interval does not finish its task." actions={<Button variant="outline" asChild><Link href="/apps/neuralflow/rewards">Stone collection</Link></Button>}>
    {finished && !focus && <SessionComplete key={finished.sessionId} completed={finished.completed} taskDone={finished.taskDone} stone={finished.stoneEarned ? clarityStone : undefined} reason={finishedReward && stoneReason(finishedReward, state.tasks)} earnedTotal={state.rewards.filter((reward) => reward.title === "Clarity stone").length} animate={finished.animate} onRestart={finished.taskDone || !state.tasks.some((item) => item.id === finished.taskId && item.status !== "DONE") ? undefined : () => start(finished.taskId)} onDismiss={() => setFinished(null)} />}
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]"><Panel title={focus ? isBreak ? "Break interval" : task?.title || "Task no longer available" : "Protect an interval"} description="Focus 25 minutes, short break 5, or long break 15. Breaks never auto-start, move tasks, or grant rewards.">
      <div className="flex flex-col items-center gap-5 py-8"><StoneStage className="w-full max-w-sm" caption={focus ? (isBreak ? "Break" : "Now") : "Ready"} sub={<span role="timer" aria-label={`${Math.floor(remaining / 60)} minutes ${remaining % 60} seconds remaining`}>{String(Math.floor(remaining / 60)).padStart(2, "0")}:{String(remaining % 60).padStart(2, "0")}</span>}>{clarityStone && !isBreak && (focus || mode === "focus") ? <FormingStone stone={clarityStone} progress={formingProgress(elapsed, focus ? focus.duration * 60 : minutes * 60)} reduceMotion={state.preferences.reducedMotion} /> : null}</StoneStage><Status>{focus ? remaining === 0 ? "Interval finished; outcome awaiting review" : focus.status === "running" ? "Running" : "Paused" : "Ready"}</Status>{clarityStone && !isBreak && (focus || mode === "focus") ? <p className="text-xs text-muted-foreground">{focus ? "Clarity stone forming" : "Record a completed interval to earn a clarity stone"}</p> : null}<progress aria-label="Interval progress" className="h-2 w-full max-w-sm accent-primary" max={focus ? focus.duration * 60 : minutes * 60} value={elapsed} /><div className="flex flex-wrap justify-center gap-2"><Button onClick={toggle} disabled={!focus && mode === "focus" && !eligible.length}>{focus?.status === "running" ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}{focus ? remaining === 0 ? "Record outcome" : focus.status === "running" ? "Pause" : "Resume" : "Start interval"}</Button>
        <Dialog open={resetOpen} onOpenChange={setResetOpen}><DialogTrigger asChild><Button variant="outline" disabled={!focus}><RotateCcw aria-hidden className="size-4" />Reset</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Reset this interval?</DialogTitle><DialogDescription>Elapsed time will be discarded. The session will return to its full duration and pause. No reward is granted.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setResetOpen(false)}>Keep interval</Button><Button onClick={reset}>Reset and pause</Button></div></DialogContent></Dialog>
        <Dialog open={outcomeOpen} onOpenChange={setOutcomeOpen}><DialogTrigger asChild><Button variant="outline" disabled={!focus}><Timer aria-hidden className="size-4" />{remaining === 0 ? "Review outcome" : "End early"}</Button></DialogTrigger><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{isBreak ? "End break" : "Record focus outcome"}</DialogTitle><DialogDescription>{isBreak ? "Breaks do not grant focus stones." : remaining === 0 ? "The interval reached zero. Save once to earn one local preview stone; reflection is optional." : "You can end deliberately before the interval finishes. Early endings do not earn completion stones."}</DialogDescription></DialogHeader><form onSubmit={recordOutcome} className="space-y-4">{!isBreak && <><Field label="What changed? (optional)"><Textarea name="outcome" placeholder="A decision, an artifact, or a useful lesson" rows={4} /></Field><Field label="Next step (optional)"><Textarea name="next" rows={2} /></Field><label className="flex items-center gap-2 text-[13px]"><input name="done" type="checkbox" className="size-4" />Also mark the linked task done</label></>}<Button type="submit">{isBreak ? "End break locally" : "Save outcome and end locally"}</Button></form></DialogContent></Dialog>
      </div><p className="text-xs text-muted-foreground">Space pauses/resumes; R opens reset confirmation when no control or dialog has focus.</p></div>
      <div role="status" className="text-center text-[13px] text-muted-foreground">{focus && remaining === 0 ? "Interval finished. Review the outcome to close this session." : ""}</div>
    </Panel><div className="space-y-4"><Panel title="Session setup"><fieldset disabled={!!focus} className="space-y-4 disabled:opacity-60"><Field label="Canonical task"><Select value={chosenTask} onChange={(event) => setTaskId(event.target.value)}><option value="">Choose a task</option>{eligible.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></Field><Field label="Interval type"><Select value={mode} onChange={(event) => { setMode(event.target.value); setMinutes(event.target.value === "focus" ? 25 : event.target.value === "short" ? 5 : 15); }}><option value="focus">Focus sprint</option><option value="short">Short break</option><option value="long">Long break</option></Select></Field><Field label="Duration (minutes)"><Input type="number" value={minutes} min={1} max={120} onChange={(event) => setMinutes(Math.min(120, Math.max(1, Number(event.target.value) || 1)))} /></Field></fieldset>{focus && <p className="mt-3 text-xs text-muted-foreground">Finish or end the active session before choosing another task.</p>}</Panel>{!eligible.length && !focus && <Empty title="No active tasks" description="Capture or reopen a task before starting a focus sprint. Break intervals are still available." action={<Button variant="outline" asChild><Link href="/neuralflow/work?view=list">Open tasks</Link></Button>} />}<Stat label="Local completed focus intervals" value={state.rewards.filter((reward) => reward.sessionId.startsWith("neuralflow-focus:")).length} hint="Based on recorded, idempotent rewards; not inferred from task estimates" /><Panel title="Persistence boundaries"><p className="text-[13px] leading-relaxed text-muted-foreground">This session and its optional canonical note live in browser preview storage, not Neon. There is no production session history, cross-device sync, alarm permission, or background notification service.</p></Panel></div></div>
  </Screen>;
}
