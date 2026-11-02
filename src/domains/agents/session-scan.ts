import { and, eq, sql } from "drizzle-orm";
import type { SessionRecord } from "@/lib/agent-artifacts/scan";
import { putBlob } from "@/integrations/object-store/object-store";
import { withTransaction } from "@/lib/db-transaction";
import type { AuthContext } from "@/lib/auth";
import { recordAudit } from "../audit/record";
import { blobObjects } from "../audit/schema";
import { importedAgentSessions } from "./schema";

/*
 * Transactional ingest for scanned local agent sessions (the D1 flow):
 * redacted summary from the parser, raw bytes as-received into the blob
 * ledger, one idempotent upsert per (workspace, source, session id), one
 * audit row per session — all inside a single transaction, so a scan either
 * lands whole or not at all.
 *
 * Blob reuse follows the capture.ts rule: look the content hash up first and
 * skip the byte write entirely when this transcript is already stored. The
 * intake.ts ON CONFLICT race pattern covers two simultaneous scans of the
 * same content.
 *
 * Decision notes follow PR1's rule at this boundary: a non-empty note is
 * "recorded", its absence is "inferred", and nothing else can claim recorded.
 * A re-scan without a note never erases a previously recorded one.
 */

export type ScanIngestInput = {
  /** What the operator said this batch of sessions was for, when they said it. */
  decisionNote?: string;
};

export type ScanIngestResult = {
  imported: number;
  updated: number;
  /** Transcripts whose bytes were already in the ledger and were not rewritten. */
  blobsDeduped: number;
  /** Per-session import ids for the UI, in scan order. */
  sessionIds: string[];
};

function asDate(iso: string | undefined): Date | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** False when a note is only whitespace — a blank line is not a rationale. */
function isRecordedNote(note: string | undefined): note is string {
  return note !== undefined && note.trim() !== "";
}

export async function ingestSessionRecords(
  auth: AuthContext,
  records: readonly SessionRecord[],
  input: ScanIngestInput = {},
): Promise<ScanIngestResult> {
  const decisionStatus = isRecordedNote(input.decisionNote) ? "recorded" : "inferred";
  const decisionNote = isRecordedNote(input.decisionNote) ? input.decisionNote.trim() : null;

  return withTransaction(async (tx) => {
    const result: ScanIngestResult = { imported: 0, updated: 0, blobsDeduped: 0, sessionIds: [] };

    for (const record of records) {
      const [existingBlob] = await tx
        .select({ id: blobObjects.id })
        .from(blobObjects)
        .where(and(eq(blobObjects.workspaceId, auth.workspaceId), eq(blobObjects.contentHash, record.rawSha256)))
        .limit(1);

      let blobId: string;
      if (existingBlob) {
        blobId = existingBlob.id;
        result.blobsDeduped += 1;
      } else {
        const stored = await putBlob({
          bytes: new TextEncoder().encode(record.raw),
          filename: `agent-session-${record.rawSha256.slice(0, 12)}.jsonl`,
          contentType: "application/x-ndjson",
          workspaceId: auth.workspaceId,
          contentHash: record.rawSha256,
        });
        const [blob] = await tx
          .insert(blobObjects)
          .values({
            workspaceId: auth.workspaceId,
            storageKey: stored.storageKey,
            contentHash: stored.contentHash,
            sizeBytes: stored.sizeBytes,
            mimeType: "application/x-ndjson",
          })
          .onConflictDoNothing({ target: blobObjects.storageKey })
          .returning({ id: blobObjects.id });
        // Two scans of the same content race on the storage-key unique index;
        // the loser joins the winner's row rather than failing the scan.
        blobId =
          blob?.id ??
          (
            await tx
              .select({ id: blobObjects.id })
              .from(blobObjects)
              .where(eq(blobObjects.storageKey, stored.storageKey))
              .limit(1)
          )[0]?.id;
        if (blobId === undefined) throw new Error(`blob row vanished during scan ingest (${stored.storageKey})`);
      }

      const summary = record.parsed.summary;
      const [row] = await tx
        .insert(importedAgentSessions)
        .values({
          workspaceId: auth.workspaceId,
          source: record.source,
          externalSessionId: summary.externalSessionId,
          cwd: summary.cwd,
          startedAt: asDate(summary.startedAt),
          lastActivityAt: asDate(summary.lastActivityAt),
          summary,
          rawBlobId: blobId,
          decisionNote,
          decisionStatus,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .onConflictDoUpdate({
          target: [
            importedAgentSessions.workspaceId,
            importedAgentSessions.source,
            importedAgentSessions.externalSessionId,
          ],
          set: {
            cwd: summary.cwd,
            startedAt: sql`coalesce(excluded.started_at, ${importedAgentSessions.startedAt})`,
            lastActivityAt: sql`coalesce(excluded.last_activity_at, ${importedAgentSessions.lastActivityAt})`,
            summary,
            rawBlobId: sql`coalesce(excluded.raw_blob_id, ${importedAgentSessions.rawBlobId})`,
            // A re-scan never erases what a human previously recorded.
            decisionNote: decisionNote ?? sql`${importedAgentSessions.decisionNote}`,
            decisionStatus:
              decisionStatus === "recorded" ? decisionStatus : sql`${importedAgentSessions.decisionStatus}`,
            updatedBy: auth.userId,
            updatedAt: new Date(),
            version: sql`${importedAgentSessions.version} + 1`,
          },
        })
        .returning({
          id: importedAgentSessions.id,
          // mutable's version starts at 1 on insert and is bumped on conflict,
          // so version === 1 is exactly "this call created the row".
          version: importedAgentSessions.version,
        });

      if (row.version === 1) result.imported += 1;
      else result.updated += 1;
      result.sessionIds.push(row.id);

      await recordAudit(
        auth,
        {
          action: "agents.external_session_imported",
          subjectType: "imported_agent_session",
          subjectId: row.id,
          summary: `Imported ${record.source} session ${summary.externalSessionId} (${summary.humanPrompts.length} prompt(s), ${summary.filesTouched.length} file(s) touched)`,
          metadata: {
            source: record.source,
            externalSessionId: summary.externalSessionId,
            cwd: summary.cwd,
            rawBlobId: blobId,
            filesTouched: summary.filesTouched.length,
            commandsRun: summary.commandsRun.length,
            failures: summary.failures.length,
          },
        },
        tx,
      );
    }

    return result;
  });
}
