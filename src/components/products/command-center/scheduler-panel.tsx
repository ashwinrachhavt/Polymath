"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Select } from "./controls";
import { Field, Panel, Status } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { clamp, earliestSuggestionHour, eveningRange, hourLabel, schedulerProblems, topicOptions, weekdayNames, weekdaySummary, workEndRange, workStartRange } from "@/components/workspace/scheduler";
import type { SchedulerPreferences } from "@/components/workspace/types";

/*
 * Scheduling preferences. Values are edited as a draft so an invalid range can
 * be shown and refused rather than written into the workspace one keystroke at
 * a time. Nothing here schedules anything: it bounds the window a future
 * suggestion engine may propose inside.
 */
const hourOptions = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, index) => min + index);

export function SchedulerPanel() {
  const { state, updatePreferences, notify } = useWorkspace();
  const saved = state.preferences.scheduler;
  const [draft, setDraft] = useState<SchedulerPreferences>(saved);
  const problems = schedulerProblems(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  function set(patch: Partial<SchedulerPreferences>) {
    setDraft((current) => ({ ...current, ...patch }));
  }
  return <Panel title="Scheduling preferences" description="Bounds the window focus and planning suggestions may use. No calendar provider is read or written from here." actions={<Status>{dirty ? "Unsaved changes" : "Saved locally"}</Status>}>
    <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (problems.length) { notify(problems[0]); return; } const saved = updatePreferences({ scheduler: draft }); if (!saved.ok || !saved.persisted) return; notify("Scheduling preferences saved locally. Focus suggestions use the earliest start hour."); }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Earliest focus start">
          <Select value={draft.workStartHour} onChange={(event) => set({ workStartHour: clamp(Number(event.target.value), workStartRange.min, workStartRange.max) })}>
            {hourOptions(workStartRange.min, workStartRange.max).map((hour) => <option key={hour} value={hour}>{hourLabel(hour)} ({hour}:00)</option>)}
          </Select>
        </Field>
        <Field label="Work day ends">
          <Select value={draft.workEndHour} onChange={(event) => set({ workEndHour: clamp(Number(event.target.value), workEndRange.min, workEndRange.max) })}>
            {hourOptions(workEndRange.min, workEndRange.max).map((hour) => <option key={hour} value={hour}>{hourLabel(hour)} ({hour}:00)</option>)}
          </Select>
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">Suggestions are placed no earlier than {hourLabel(earliestSuggestionHour(draft))}, the earliest focus start.</p>

      <fieldset className="grid gap-2">
        <legend className="text-[13px] font-medium">Working days</legend>
        <div className="flex flex-wrap gap-1.5">
          {weekdayNames.map((name, index) => {
            const selected = draft.weekdays.includes(index);
            return <Button key={name} type="button" size="sm" variant={selected ? "secondary" : "outline"} aria-pressed={selected}
              onClick={() => set({ weekdays: selected ? draft.weekdays.filter((day) => day !== index) : [...draft.weekdays, index].sort((a, b) => a - b) })}>{name}</Button>;
          })}
        </div>
        <p className="text-xs text-muted-foreground">{weekdaySummary(draft.weekdays)}</p>
      </fieldset>

      <Check label="Propose focus suggestions inside these hours" checked={draft.suggestionsEnabled} onChange={(suggestionsEnabled) => set({ suggestionsEnabled })} />

      <fieldset className="grid gap-3 border-t border-border pt-4">
        <legend className="text-[13px] font-medium">Evening sessions</legend>
        <Check label="Allow a separate evening session" checked={draft.eveningEnabled} onChange={(eveningEnabled) => set({ eveningEnabled })} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Evening starts">
            <Select disabled={!draft.eveningEnabled} value={draft.eveningStartHour} onChange={(event) => set({ eveningStartHour: clamp(Number(event.target.value), eveningRange.min, eveningRange.max) })}>
              {hourOptions(eveningRange.min, eveningRange.max).map((hour) => <option key={hour} value={hour}>{hourLabel(hour)} ({hour}:00)</option>)}
            </Select>
          </Field>
          <Field label="Session label">
            <input disabled={!draft.eveningEnabled} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-[13px]" maxLength={60} value={draft.eveningTitle} onChange={(event) => set({ eveningTitle: event.target.value })} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="grid gap-2 border-t border-border pt-4">
        <legend className="text-[13px] font-medium">Preferred topics</legend>
        <div className="flex flex-wrap gap-1.5">
          {topicOptions.map((topic) => {
            const selected = draft.topics.includes(topic);
            return <Button key={topic} type="button" size="sm" variant={selected ? "secondary" : "outline"} aria-pressed={selected}
              onClick={() => set({ topics: selected ? draft.topics.filter((item) => item !== topic) : [...draft.topics, topic] })}>{topic}</Button>;
          })}
        </div>
        <p className="text-xs text-muted-foreground">Used to rank suggestions that match. Unmatched work is still suggested.</p>
      </fieldset>

      {problems.length > 0 && <ul role="alert" className="grid gap-1 text-[13px] text-destructive">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      <div className="flex gap-2">
        <Button type="submit" variant="outline" disabled={!dirty || problems.length > 0}>Save scheduling preferences</Button>
        {dirty && <Button type="button" variant="ghost" onClick={() => setDraft(saved)}>Discard changes</Button>}
      </div>
    </form>
  </Panel>;
}
