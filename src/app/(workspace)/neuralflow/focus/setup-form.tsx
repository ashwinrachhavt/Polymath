"use client";

import { useState, useTransition } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/workspace/ui";
import { startSessionAction } from "../work/actions";

export type TierOption = {
  value: "normal" | "timeout" | "deep";
  label: string;
  detail: string;
};

/*
 * Setup (spec §3): what to focus on, how long, and the strictness tier - the
 * contract the server will hold for this session. Starting is a server
 * action; the page re-renders into the live view when it lands. The blocklist
 * editor lives beside this form (blocklist-editor.tsx), enforced by the
 * browser companion that reads it.
 */
export function FocusSetup({ tasks, tiers }: { tasks: Array<{ id: string; title: string }>; tiers: TierOption[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [taskId, setTaskId] = useState("");
  const [subject, setSubject] = useState("");
  const [plannedMinutes, setPlannedMinutes] = useState("25");
  const [tier, setTier] = useState<TierOption["value"]>("normal");

  const start = () => {
    setError(null);
    startTransition(async () => {
      const minutes = Number(plannedMinutes);
      const result = await startSessionAction({
        subject: subject.trim(),
        plannedMinutes: plannedMinutes.trim() && minutes >= 1 ? minutes : null,
        taskId: taskId || undefined,
        strictness: tier,
      });
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <section className="panel min-w-0 rounded-xl p-4">
      <div className="mb-4">
        <h2 className="text-body-dense font-medium">Start a session</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          One session at a time. The tier sets what the server holds you to.
        </p>
      </div>
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="What are you focusing on?">
            <Input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              maxLength={200}
              placeholder="The one thing this session is for"
            />
          </Field>
          <Field label="Linked task (optional)">
            <Select value={taskId} onChange={(event) => setTaskId(event.target.value)} aria-label="Linked task">
              <option value="">No task</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Planned minutes">
          <Input
            type="number"
            min={1}
            max={480}
            value={plannedMinutes}
            onChange={(event) => setPlannedMinutes(event.target.value)}
            className="sm:max-w-32"
          />
        </Field>
        <fieldset className="min-w-0">
          <legend className="text-body-dense font-medium">Strictness</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {tiers.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-body-dense",
                  tier === option.value ? "border-app-accent bg-muted/40" : "border-border hover:bg-muted/40",
                )}
              >
                <span className="flex items-center gap-2 font-medium">
                  <input
                    type="radio"
                    name="strictness"
                    value={option.value}
                    checked={tier === option.value}
                    onChange={() => setTier(option.value)}
                  />
                  {option.label}
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">{option.detail}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={pending} onClick={start}>
            Start focusing
          </Button>
          {error ? (
            <p className="text-destructive text-body-dense" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
