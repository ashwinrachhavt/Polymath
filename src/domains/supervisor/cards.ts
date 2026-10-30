/*
 * ASH-306: surface cards. A conversational-navigation answer is data plus a
 * way out: the same rows the destination surface would show, bounded, with
 * deep links, so the thread is a real map and never a screenshot of one.
 * Every card reads canonical Neon rows through the owning domain's queries -
 * a card that invents items is worse than no card, so empty stays empty.
 */
import { listTopPendingProposals } from "@/domains/actions/queries";
import { listRecentRuns } from "@/domains/agents/queries";
import { listEventsBetween } from "@/domains/calendar/queries";
import type { AuthContext } from "@/domains/identity/resolve";
import { listDocuments } from "@/domains/knowledge/library";
import { pageNotes } from "@/domains/knowledge/notes";
import { listOpenTasks } from "@/domains/work/queries";
import type { NavigationIntent, SurfaceKind } from "./navigation";
import { SURFACE_HREF } from "./navigation";

export const SURFACE_CARD_PART = "supervisor-surface";

export type SurfaceCardItem = { label: string; href?: string; meta?: string };

export type SurfaceCard = {
  surface: SurfaceKind | "note_search";
  title: string;
  /** The canonical full surface; the card is a window, this is the door. */
  href: string;
  items: SurfaceCardItem[];
  emptyText: string | null;
};

const CARD_LIMIT = 5;

function fmtDay(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export async function buildSurfaceCard(auth: AuthContext, intent: NavigationIntent): Promise<SurfaceCard> {
  if (intent.kind === "open_note") {
    const { items } = await pageNotes(auth, { query: intent.query, limit: CARD_LIMIT, offset: 0 });
    return {
      surface: "note_search",
      title: `Notes matching "${intent.query}"`,
      href: `/polymath/notes?q=${encodeURIComponent(intent.query)}`,
      items: items.map((note) => ({
        label: note.title || "Untitled note",
        href: `/polymath/notes?id=${note.id}`,
        meta: `v${note.version} · ${fmtDay(note.updatedAt)}`,
      })),
      emptyText: `No notes match "${intent.query}" yet.`,
    };
  }

  switch (intent.surface) {
    case "tasks": {
      const tasks = await listOpenTasks(auth, CARD_LIMIT);
      return {
        surface: "tasks",
        title: "Open tasks",
        href: SURFACE_HREF.tasks,
        items: tasks.map((task) => ({
          label: task.title,
          href: `/neuralflow/work?task=${task.id}`,
          meta: task.dueAt ? `due ${fmtDay(task.dueAt)}` : task.priority ?? undefined,
        })),
        emptyText: "No open tasks.",
      };
    }
    case "notes": {
      const { items } = await pageNotes(auth, { limit: CARD_LIMIT, offset: 0 });
      return {
        surface: "notes",
        title: "Recent notes",
        href: SURFACE_HREF.notes,
        items: items.map((note) => ({
          label: note.title || "Untitled note",
          href: `/polymath/notes?id=${note.id}`,
          meta: fmtDay(note.updatedAt),
        })),
        emptyText: "No notes yet.",
      };
    }
    case "decisions": {
      const proposals = await listTopPendingProposals(auth.workspaceId, CARD_LIMIT);
      return {
        surface: "decisions",
        title: "Waiting on your decision",
        href: SURFACE_HREF.decisions,
        items: proposals.map((proposal) => ({
          label: proposal.title,
          href: `/?proposal=${proposal.id}`,
          meta: proposal.capability,
        })),
        emptyText: "Nothing needs your decision.",
      };
    }
    case "runs": {
      const runs = await listRecentRuns(auth.workspaceId, CARD_LIMIT);
      return {
        surface: "runs",
        title: "Recent runs",
        href: SURFACE_HREF.runs,
        items: runs.map((run) => ({
          label: run.objective?.slice(0, 80) || run.summary?.slice(0, 80) || "Untitled run",
          href: `/polymath/${run.id}`,
          meta: run.state,
        })),
        emptyText: "No runs yet.",
      };
    }
    case "calendar": {
      const now = new Date();
      const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      const events = await listEventsBetween(auth, dayStart, dayEnd);
      return {
        surface: "calendar",
        title: "Today",
        href: SURFACE_HREF.calendar,
        items: events.slice(0, CARD_LIMIT).map((event) => ({
          label: event.title,
          href: SURFACE_HREF.calendar,
          meta: fmtTime(event.startsAt),
        })),
        emptyText: "Nothing scheduled today.",
      };
    }
    case "library": {
      const page = await listDocuments(auth, { limit: CARD_LIMIT });
      const docs = page.rows;
      return {
        surface: "library",
        title: "Recently added to the library",
        href: SURFACE_HREF.library,
        items: docs.map((doc) => ({
          label: doc.title,
          href: `/polymath/library/${doc.id}`,
        })),
        emptyText: "The library is empty.",
      };
    }
  }
}
