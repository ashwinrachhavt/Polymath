"use client";

import { useTransition } from "react";
import { Select } from "@/components/ui/select";
import { setModelAction } from "./model-actions";
import type { ModelOption } from "@/domains/agents/models";

/*
 * The model for the next run.
 *
 * Run-scoped on purpose: the choice is written to the profile and frozen into
 * the run at start, so a conversation cannot change model mid-thread. A thread
 * that switched models halfway would have no single answer to "what produced
 * this", and the spend row would disagree with the transcript.
 *
 * Models whose provider key is missing never reach this list — the server
 * filters them — so every option here can actually run. A picker that offers a
 * dead model is worse than a short list.
 */
export function ModelPicker({
  models,
  current,
  unavailable,
}: {
  models: ModelOption[];
  current: string;
  unavailable: ReadonlyArray<{ id: string; label: string; reason: string }>;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="assistant-model" className="text-muted-foreground text-[12px]">
        Model
      </label>
      <Select
        id="assistant-model"
        aria-describedby="assistant-model-note"
        value={current}
        disabled={pending}
        onChange={(event) => {
          const next = event.target.value;
          startTransition(async () => {
            await setModelAction({ modelId: next });
          });
        }}
        className="border-input bg-background h-8 w-auto rounded-md border px-2 text-[12px]"
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </Select>
      <p id="assistant-model-note" className="text-muted-foreground text-[12px]">
        {pending
          ? "Saving…"
          : models.find((model) => model.id === current)?.note ?? "Used for the next conversation."}
      </p>
      {unavailable.map((entry) => (
        <p key={entry.id} className="text-muted-foreground basis-full text-[11px]">
          {entry.label} is not listed: {entry.reason}
        </p>
      ))}
    </div>
  );
}
