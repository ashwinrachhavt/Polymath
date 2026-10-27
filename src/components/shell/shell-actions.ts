"use server";

import { and, desc, eq, ilike, isNull, ne, or } from "drizzle-orm";
import { revalidatePath, updateTag } from "next/cache";
import { createCapture } from "@/domains/capture/commands";
import { captures } from "@/domains/capture/schema";
import { contacts } from "@/domains/crm/schema";
import { artifacts, documents } from "@/domains/knowledge/schema";
import { opportunities } from "@/domains/opportunities/schema";
import { searchTasksByProse } from "@/domains/work/queries";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { capturesTag } from "@/lib/cache-tags";
import { db } from "@/lib/db";

/*
 * The shared header writes and reads the same canonical Neon records every
 * other surface uses (assessment item A): capture is the single entry point
 * for new content (ASH-314) and lands in the durable inbox, and search finds
 * those rows - not the browser preview store.
 */

export type QuickCreateResult = { ok: true; message: string } | { ok: false; error: string; existingId?: string };

/**
 * The one global entry point for new content (ASH-314): everything starts as
 * a capture - text, a link, a paste. The system reads it and proposes what it
 * becomes; the owner never picks an object type up front. A bare URL dedupes
 * on (workspace, source, url) and answers with the capture already in the
 * inbox, so a re-paste links instead of stacking a second row.
 */
export async function quickCapture(
  text: string,
  idempotencyKey: string,
): Promise<QuickCreateResult> {
  // Writes the canonical capture row, so member or above (ASH-121 AC05).
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const value = text.trim();
  if (!value) return { ok: false, error: "Nothing to save." };
  try {
    await createCapture(auth, { text: value, idempotencyKey });
    updateTag(capturesTag(auth));
    revalidatePath("/command-center/inbox");
    return { ok: true, message: "Saved to your inbox." };
  } catch (cause) {
    const code = (cause as { code?: string })?.code;
    if (code === "conflict" || code === "stale_write") {
      return { ok: false, error: (cause as Error).message, existingId: (cause as { existingId?: string }).existingId };
    }
    throw cause;
  }
}

export type WorkspaceRecord = {
  kind: "task" | "note" | "contact" | "inbox" | "opportunity" | "document";
  id: string;
  label: string;
  context: string;
  href: string;
};

export async function searchWorkspace(query: string): Promise<WorkspaceRecord[]> {
  const auth = await getAuthContext();
  const q = query.trim().replace(/[%_]/g, " ");
  if (q.length < 2) return [];
  const pattern = `%${q}%`;

  const [taskRows, captureRows, noteRows, contactRows, opportunityRows, documentRows] = await Promise.all([
    searchTasksByProse(auth, [q], { limit: 6 }),
    db
      .select({ id: captures.id, text: captures.text, url: captures.url, state: captures.processingState })
      .from(captures)
      .where(
        and(
          eq(captures.workspaceId, auth.workspaceId),
          // A converted capture's canonical record is what it became.
          ne(captures.processingState, "converted"),
          or(ilike(captures.text, pattern), ilike(captures.url, pattern)),
        ),
      )
      .orderBy(desc(captures.createdAt))
      .limit(4),
    db
      .select({ id: artifacts.id, title: artifacts.title })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.workspaceId, auth.workspaceId),
          eq(artifacts.kind, "note"),
          isNull(artifacts.archivedAt),
          ilike(artifacts.title, pattern),
        ),
      )
      .orderBy(desc(artifacts.updatedAt))
      .limit(4),
    db
      .select({ id: contacts.id, name: contacts.fullName })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, auth.workspaceId), ilike(contacts.fullName, pattern)))
      .orderBy(desc(contacts.updatedAt))
      .limit(4),
    db
      .select({ id: opportunities.id, title: opportunities.title, stage: opportunities.stage })
      .from(opportunities)
      .where(and(eq(opportunities.workspaceId, auth.workspaceId), isNull(opportunities.archivedAt), ilike(opportunities.title, pattern)))
      .orderBy(desc(opportunities.updatedAt))
      .limit(4),
    db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(and(eq(documents.workspaceId, auth.workspaceId), isNull(documents.archivedAt), ilike(documents.title, pattern)))
      .orderBy(desc(documents.updatedAt))
      .limit(4),
  ]);

  const found: WorkspaceRecord[] = [
    ...opportunityRows.map((row) => ({
      kind: "opportunity" as const,
      id: row.id,
      label: row.title,
      context: `Opportunity · ${row.stage.replace("_", " ")}`,
      // Opportunities left the rail in the IA simplification; People is the
      // canonical screen their records live under. People takes no id param,
      // so the row opens the list; the record itself is reachable through its
      // company's context (P1 TODO: an opportunity inspector restores the deep link).
      href: "/command-center/relationships/people",
    })),
    ...documentRows.map((row) => ({
      kind: "document" as const,
      id: row.id,
      label: row.title,
      context: "Document in Files",
      href: `/alfred/files?doc=${row.id}`,
    })),
    ...taskRows.map((row) => ({
      kind: "task" as const,
      id: row.id,
      label: row.title,
      context: `Task · ${row.status.replace("_", " ")}`,
      href: `/neuralflow/work?view=saved&task=${row.id}`,
    })),
    ...noteRows.map((row) => ({
      kind: "note" as const,
      id: row.id,
      label: row.title,
      context: "Note in Alfred",
      href: `/alfred/notes?id=${row.id}`,
    })),
    ...contactRows.map((row) => ({
      kind: "contact" as const,
      id: row.id,
      label: row.name,
      context: "Contact",
      href: `/command-center/relationships/contacts?id=${row.id}`,
    })),
    ...captureRows.map((row) => ({
      kind: "inbox" as const,
      id: row.id,
      label: (row.text ?? row.url ?? "Captured item").slice(0, 80),
      context: row.state === "converted" ? "Inbox · converted" : "Inbox capture",
      href: "/command-center/inbox",
    })),
  ];
  return rankRecords(found, q);
}


/*
 * Best match first across every kind: exact title, then prefix, then a word
 * prefix, then any substring. Stable within a tier, so each query's own
 * recency order is kept.
 */
function matchTier(label: string, q: string): number {
  const l = label.toLowerCase();
  const needle = q.toLowerCase();
  if (l === needle) return 0;
  if (l.startsWith(needle)) return 1;
  if (l.split(/[^a-z0-9]+/).some((w) => w.startsWith(needle))) return 2;
  return 3;
}

function rankRecords(records: WorkspaceRecord[], q: string): WorkspaceRecord[] {
  return records
    .map((record, index) => ({ record, index, tier: matchTier(record.label, q) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((entry) => entry.record);
}

/**
 * A file capture lands through POST /api/v1/captures/file (the 4.5 MB
 * multipart path server actions cannot take); this expires the cached inbox
 * surfaces afterwards, the same refresh quickCreate does for text captures.
 */
export async function refreshInbox(): Promise<void> {
  const auth = await getAuthContext();
  // Invalidates only the caller's own workspace tag; still a guarded action.
  requireRole(auth, "viewer");
  updateTag(capturesTag(auth));
  revalidatePath("/command-center/inbox");
}
