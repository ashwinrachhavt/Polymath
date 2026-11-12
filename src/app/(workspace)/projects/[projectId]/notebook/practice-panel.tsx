"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ChallengeFormat } from "@/domains/learning/challenge-content";
import { startPracticeAction } from "./practice-actions";
import { PRACTICE_NAMES, useRefreshWhile } from "./practice-session";
import { randomId } from "@/lib/random-id";

/*
 * Practice in the Notebook: two buttons that each start one exercise, and the
 * exercises already made. Starting returns at once; the row says it is being
 * prepared and turns into a link by itself.
 */

export type PracticeItem = {
  id: string;
  format: ChallengeFormat;
  status: "preparing" | "ready" | "failed";
  error: string | null;
  objective: string | null;
  ago: string;
  attemptCount: number;
};

const FORMATS: ChallengeFormat[] = ["predict", "bug_hunt"];

export function PracticePanel({
  projectId,
  documentIds,
  items,
}: {
  projectId: string;
  /** The ready sources an exercise is made from. */
  documentIds: string[];
  items: PracticeItem[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // A resend after a failed request replays its key; a successful start clears it.
  const request = useRef<{ format: ChallengeFormat; key: string } | null>(null);
  useRefreshWhile(items.some((item) => item.status === "preparing"));

  function start(format: ChallengeFormat) {
    setError(null);
    if (request.current?.format !== format) request.current = { format, key: randomId() };
    const idempotencyKey = request.current.key;
    startTransition(async () => {
      const result = await startPracticeAction({ projectId, documentIds, format, idempotencyKey });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      request.current = null;
    });
  }

  return (
    <section aria-labelledby="practice-title" className="panel rounded-xl p-3">
      <h2 id="practice-title" className="text-body-dense font-medium">
        Practice
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {documentIds.length === 0
          ? "A source must finish reading before you can practice on it."
          : "Use what you read on a case you have not seen."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {FORMATS.map((format) => (
          <Button
            key={format}
            variant="outline"
            disabled={pending || documentIds.length === 0}
            onClick={() => start(format)}
          >
            {PRACTICE_NAMES[format]}
          </Button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {items.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">
                {PRACTICE_NAMES[item.format]} · {item.ago}
                {item.attemptCount > 0 ? ` · ${item.attemptCount} ${item.attemptCount === 1 ? "try" : "tries"}` : ""}
              </p>
              {item.status === "ready" ? (
                <Link
                  href={"/projects/" + projectId + "/notebook/practice?challenge=" + item.id}
                  className="text-body-dense font-medium underline-offset-4 hover:underline"
                >
                  {item.objective}
                </Link>
              ) : (
                <p role="status" className="text-body-dense text-muted-foreground">
                  {item.status === "preparing" ? "Getting it ready…" : item.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
