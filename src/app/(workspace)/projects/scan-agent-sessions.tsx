"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FolderSearch, Loader2 } from "lucide-react";

import { scanAgentSessionsAction } from "./actions";
import { Button } from "@/components/ui/button";

/*
 * The "Scan agent sessions" control (Workbench D3): the user-triggered read of
 * the local Claude Code / Codex folders — the only ingest path, and the one
 * the disclosure line describes. The optional note typed here is what makes a
 * session's decision "recorded" rather than inferred, so it sits beside the
 * button, not buried. A scan covers the workspace's roots (env-configured);
 * the project page section then shows the sessions whose cwd matches the
 * project's local repo path.
 */

type ScanSummary = {
  imported: number;
  updated: number;
  blobsDeduped: number;
  skipped: { source: string; path: string; kind: string; reason: string }[];
  unavailable: { source: string; kind: string; message: string }[];
  decode: { records: number; skippedRecords: number };
};

export function ScanAgentSessions() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanSummary | null>(null);

  function scan() {
    if (pending) return;
    setError(null);
    start(async () => {
      const outcome = await scanAgentSessionsAction({ decisionNote: note.trim() || undefined });
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      setNote("");
      setResult(outcome);
      // The section's rows are server-rendered; a refresh re-reads them.
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={2000}
          placeholder="What were these sessions for? (optional)"
          aria-label="Decision note for these sessions (optional)"
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 text-body-dense"
        />
        <Button size="sm" variant="outline" disabled={pending} onClick={scan}>
          {pending ? <Loader2 aria-hidden className="animate-spin" /> : <FolderSearch aria-hidden className="size-4" />}
          {pending ? "Scanning…" : "Scan agent sessions"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="text-xs text-muted-foreground" role="status">
          <p>
            {result.imported} imported, {result.updated} updated, {result.decode.records.toLocaleString()} records read
            {result.decode.skippedRecords > 0
              ? `, ${result.decode.skippedRecords} lines skipped (kept counted, not fatal)`
              : ""}
          </p>
          {result.unavailable.length > 0 ? (
            <p>Not scanned: {result.unavailable.map((u) => `${u.source} (${u.message})`).join("; ")}</p>
          ) : null}
          {result.skipped.length > 0 ? (
            <details className="mt-1">
              <summary className="cursor-pointer">{result.skipped.length} file(s) set aside</summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {result.skipped.slice(0, 10).map((skip) => (
                  <li key={`${skip.source}:${skip.path}`} className="truncate font-mono">
                    {skip.path} ({skip.kind}): {skip.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
