"use server";

import { and, desc, eq, ilike, isNull, ne, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { createCapture, convertCaptureToTask } from "@/domains/capture/commands";
import { captures } from "@/domains/capture/schema";
import { contacts } from "@/domains/crm/schema";
import { createNote } from "@/domains/knowledge/notes";
import { artifacts } from "@/domains/knowledge/schema";
import { tasks } from "@/domains/work/schema";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";

/*
 * The shared header writes and reads the same canonical Neon records every
 * other surface uses (assessment item A): quick capture lands in the durable
 * inbox, a quick task is the canonical task (with the original kept on the
 * capture it converted), a quick note is a notebook artifact, and search
 * finds those rows - not the browser preview store.
 */

export type QuickCreateResult = { ok: true; message: string } | { ok: false; error: string };

export async function quickCreate(
  kind: "capture" | "task" | "note",
  text: string,
  idempotencyKey: string,
): Promise<QuickCreateResult> {
  // Writes the canonical capture/task/note rows, so member or above (ASH-121 AC05).
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const value = text.trim();
  if (!value) return { ok: false, error: "Nothing to save." };
  try {
    if (kind === "task") {
      const capture = await createCapture(auth, { text: value });
      await convertCaptureToTask(auth, {
        captureId: capture.id,
        expectedVersion: capture.version,
        title: value.split("\n", 1)[0],
      });
      revalidatePath("/neuralflow/work");
      revalidatePath("/command-center/inbox");
      return { ok: true, message: "Task saved to your workspace. The original stays in your inbox." };
    }
    if (kind === "note") {
      await createNote(auth, {
        idempotencyKey,
        title: value.split("\n", 1)[0].slice(0, 200) || "Note",
        plainText: value,
      });
      revalidatePath("/alfred/notebook");
      return { ok: true, message: "Note saved to your notebook." };
    }
    await createCapture(auth, { text: value });
    revalidatePath("/command-center/inbox");
    return { ok: true, message: "Saved to your inbox." };
  } catch (cause) {
    const code = (cause as { code?: string })?.code;
    if (code === "conflict" || code === "stale_write") {
      return { ok: false, error: (cause as Error).message };
    }
    throw cause;
  }
}

export type WorkspaceRecord = {
  kind: "task" | "note" | "contact" | "inbox";
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

  const [taskRows, captureRows, noteRows, contactRows] = await Promise.all([
    db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.archivedAt), ilike(tasks.title, pattern)))
      .orderBy(desc(tasks.updatedAt))
      .limit(6),
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
  ]);

  return [
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
      href: `/alfred/notebook?id=${row.id}`,
    })),
    ...contactRows.map((row) => ({
      kind: "contact" as const,
      id: row.id,
      label: row.name,
      context: "Contact",
      href: `/command-center/relationships?id=${row.id}`,
    })),
    ...captureRows.map((row) => ({
      kind: "inbox" as const,
      id: row.id,
      label: (row.text ?? row.url ?? "Captured item").slice(0, 80),
      context: row.state === "converted" ? "Inbox · converted" : "Inbox capture",
      href: "/command-center/inbox",
    })),
  ];
}
