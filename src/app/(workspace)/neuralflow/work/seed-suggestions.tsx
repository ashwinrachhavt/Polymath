"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { commitSeedAction, dismissSeedAction } from "./actions";

/*
 * Tomorrow's suggestions, as the end-of-day shutdown recorded them. The owner
 * picks these tasks the night before, so today they are the one list on Work
 * that is already a decision rather than a queue: commit it, or decline it and
 * it stops being offered.
 *
 * The reason is shown because it is the only thing separating a suggestion
 * from a task the owner forgot about.
 */
export function SeedSuggestions({
  seeds,
}: {
  seeds: Array<{ seedId: string; taskId: string; title: string; reason: string | null; version: number; taskVersion: number }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  if (seeds.length === 0) return null;

  function commit(seed: (typeof seeds)[number]) {
    setError(null);
    startTransition(async () => {
      const result = await commitSeedAction({
        seedId: seed.seedId,
        taskId: seed.taskId,
        expectedVersion: seed.taskVersion,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) {
        setError({ id: seed.seedId, message: result.error });
        return;
      }
      router.refresh();
    });
  }

  function dismiss(seed: (typeof seeds)[number]) {
    setError(null);
    startTransition(async () => {
      const result = await dismissSeedAction({ seedId: seed.seedId, expectedVersion: seed.version });
      if (!result.ok) {
        setError({ id: seed.seedId, message: result.error });
        return;
      }
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="suggested-heading" className="mb-5">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h2 id="suggested-heading" className="text-[13px] font-medium">
          Suggested today
        </h2>
        <span className="readout text-[11px] text-muted-foreground">{seeds.length}</span>
        <span className="text-[11px] text-muted-foreground">from last night&apos;s shutdown</span>
      </div>
      <ul className="divide-y divide-border/60">
        {seeds.map((seed) => (
          <li key={seed.seedId}>
            <div className="flex min-h-11 items-center gap-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-foreground">{seed.title}</p>
                {seed.reason ? <p className="truncate text-[11px] text-muted-foreground">{seed.reason}</p> : null}
                {error?.id === seed.seedId ? (
                  <p role="alert" className="text-[11px] text-destructive">{error.message}</p>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 text-[12px]"
                disabled={pending}
                onClick={() => commit(seed)}
                aria-label={`Commit ${seed.title} to today`}
              >
                Commit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 text-[12px] text-muted-foreground"
                disabled={pending}
                onClick={() => dismiss(seed)}
                aria-label={`Dismiss the suggestion ${seed.title}`}
              >
                Dismiss
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
