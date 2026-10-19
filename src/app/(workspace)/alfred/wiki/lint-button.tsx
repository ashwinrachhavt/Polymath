"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { lintWikiAction } from "./actions";

/*
 * The lint control. Findings are a list to decide over, never auto-fixed —
 * the wiki's health check reports and the owner chooses.
 */

export function LintButton() {
  const [pending, startTransition] = useTransition();
  const [findings, setFindings] = useState<{ code: string; message: string }[] | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              try {
                const result = await lintWikiAction();
                setFindings(result.findings);
              } catch {
                setFindings([{ code: "error", message: "Lint failed. Try again." }]);
              }
            });
          }}
        >
          {pending ? "Checking…" : "Lint the wiki"}
        </Button>
      </div>
      {findings ? (
        findings.length === 0 ? (
          <p role="status" className="text-muted-foreground text-xs">No findings. The wiki is consistent.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {findings.map((f, i) => (
              <li key={`${f.code}-${i}`} className="text-xs">
                <span className="text-amber-600 dark:text-amber-400">{f.code}</span>{" "}
                <span className="text-muted-foreground">{f.message}</span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
