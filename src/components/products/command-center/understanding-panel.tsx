"use client";

import { useEffect, useState } from "react";
import { Field, Unavailable } from "@/components/workspace/ui";
import {
  loadUnderstandingPreferencesAction,
  saveUnderstandingPreferencesAction,
} from "@/app/(workspace)/settings/understanding-actions";
import type { UnderstandingPreferences } from "@/domains/understanding/preferences";
import { Check } from "./controls";

/*
 * The switches behind the Polymath plugin for Claude Code and Codex. Each one
 * saves as soon as it changes. Everything starts off: the plugin explains a
 * change only when asked, and these decide what else it may do.
 */

type Loaded = UnderstandingPreferences & { version: number };

const selectClass = "h-9 rounded-md border border-input bg-background px-3 text-body-dense";

export default function UnderstandingPanel() {
  const [saved, setSaved] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadUnderstandingPreferencesAction().then((result) => {
      if (result.ok) setSaved(result.preferences);
      else setError(result.error);
    });
  }, []);

  if (error && !saved) return <Unavailable feature="Coding agent preferences">{error}</Unavailable>;
  if (!saved) {
    return (
      <p role="status" className="text-body-dense text-muted-foreground">
        Loading preferences…
      </p>
    );
  }

  const change = (patch: Partial<UnderstandingPreferences>) => {
    const next = { ...saved, ...patch };
    setSaved(next);
    setError(null);
    void saveUnderstandingPreferencesAction({
      autoSuggest: next.autoSuggest,
      pushWarning: next.pushWarning,
      questionCount: next.questionCount,
      difficulty: next.difficulty,
      expectedVersion: saved.version,
    }).then((result) => {
      if (result.ok) setSaved(result.preferences);
      else {
        setError(result.error);
        void loadUnderstandingPreferencesAction().then((fresh) => fresh.ok && setSaved(fresh.preferences));
      }
    });
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <Check
          label="Suggest an explainer after a large commit"
          checked={saved.autoSuggest}
          onChange={(autoSuggest) => change({ autoSuggest })}
        />
        <Check
          label="Warn before a push if its check was not passed"
          checked={saved.pushWarning}
          onChange={(pushWarning) => change({ pushWarning })}
        />
        <p className="text-body-dense text-muted-foreground">
          A suggestion only mentions the command. The warning never blocks a push.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Questions in a check">
          <select
            className={selectClass}
            value={saved.questionCount}
            onChange={(event) => change({ questionCount: Number(event.target.value) })}
          >
            {[5, 6, 7, 8, 9, 10].map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Difficulty">
          <select
            className={selectClass}
            value={saved.difficulty}
            onChange={(event) => change({ difficulty: event.target.value as UnderstandingPreferences["difficulty"] })}
          >
            <option value="easier">Easier</option>
            <option value="standard">Standard</option>
            <option value="harder">Harder</option>
          </select>
        </Field>
      </div>
      {error ? (
        <p role="alert" className="text-body-dense text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
