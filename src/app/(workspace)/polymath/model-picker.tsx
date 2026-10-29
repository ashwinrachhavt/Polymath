"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTransition } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
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
 * dead model is worse than a short list. Providers whose key is set but
 * broken stay out entirely: a workspace's balance state with a provider is
 * operator data, not something the product page renders.
 *
 * Local state rather than Radix, same as HistoryMenu: a flat list of options,
 * no roving focus to buy a portal for.
 */
export function ModelPicker({
  models,
  current,
}: {
  models: ModelOption[];
  current: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const currentModel = models.find((model) => model.id === current);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={container} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={pending}
        onClick={() => setOpen((state) => !state)}
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] outline-none focus-visible:ring-2 disabled:opacity-50"
      >
        {currentModel?.label ?? current}
        <ChevronsUpDown aria-hidden className="size-3" />
      </button>
      {open ? (
        <div
          id={panelId}
          role="listbox"
          aria-label="Model"
          className="panel bg-popover text-popover-foreground shadow-raised absolute top-full left-0 z-50 mt-1 w-56 rounded-[9px] p-1"
        >
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected={model.id === current}
              disabled={pending}
              onClick={() => {
                setOpen(false);
                if (model.id === current) return;
                startTransition(async () => {
                  await setModelAction({ modelId: model.id });
                });
              }}
              className="hover:bg-muted focus-visible:ring-ring flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus-visible:ring-2 disabled:opacity-50"
            >
              {model.id === current ? (
                <Check aria-hidden className="size-3.5 shrink-0" />
              ) : (
                <span aria-hidden className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{model.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
