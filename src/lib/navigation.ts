import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BookOpen,
  CalendarDays,
  GraduationCap,
  Inbox,
  Layers,
  LayoutList,
  Library,
  Lightbulb,
  NotebookPen,
  Puzzle,
  Receipt,
  Settings,
  ShieldCheck,
  Sparkles,
  Unplug,
  Users,
} from "lucide-react";

/*
 * The information architecture, in one place. The rail, the breadcrumb, the
 * mobile bar, and the command layer all read this list, so a destination
 * cannot exist in one and be missing from another.
 *
 * One product, one rail. The former Command Center / NeuralFlow / Alfred
 * split was a development scaffold over one system of record; the owner
 * directed (2026-10-19) that Polymath ship as a single product, so the rail
 * is one flat list of destinations and the app-switching chrome is gone.
 * URLs keep their historic prefixes; nothing else cares.
 */

type AppSlug = "command-center" | "neuralflow" | "polymath";

export type Destination = {
  href: string;
  label: string;
  /** What the owner does here, in the owner's words — used as the page subtitle. */
  purpose: string;
  icon: LucideIcon;
  group: AppSlug | "shared";
};

/**
 * Array order is rail order. The conversation leads: "/" redirects to it, and
 * the decision queue that used to hold the front door now lives in the
 * notifications panel in the header, beside the runs and the audit trail.
 */
export const destinations: Destination[] = [
  {
    href: "/polymath",
    label: "Polymath",
    purpose: "Start or continue a conversation.",
    icon: Sparkles,
    group: "polymath",
  },
  {
    href: "/command-center/inbox",
    label: "Inbox",
    purpose: "Clarify what arrived.",
    icon: Inbox,
    group: "command-center",
  },
  {
    href: "/polymath/notes",
    label: "Notes",
    purpose: "Write and keep your own pages.",
    icon: NotebookPen,
    group: "polymath",
  },
  {
    href: "/polymath/ideas",
    label: "Ideas",
    purpose: "Your ideas, each with its evidence.",
    icon: Lightbulb,
    group: "polymath",
  },
  {
    href: "/polymath/knowledge",
    label: "Document Vault",
    purpose: "Your uploaded documents, retrievable and connected.",
    icon: BookOpen,
    group: "polymath",
  },
  {
    href: "/projects",
    label: "Notebook",
    purpose: "Long-lived homes for a body of work, each with its own sources.",
    icon: Library,
    group: "polymath",
  },
  {
    href: "/learn",
    label: "Learn",
    purpose: "Review the flashcards that are due and take your quizzes.",
    icon: GraduationCap,
    group: "polymath",
  },
  {
    href: "/artifacts",
    label: "Artifacts",
    purpose: "Everything the assistant made that you kept.",
    icon: Layers,
    group: "polymath",
  },
  {
    href: "/polymath/skills",
    label: "Skills",
    purpose: "Give the assistant a procedure to follow.",
    icon: Puzzle,
    group: "polymath",
  },
  {
    href: "/today",
    label: "Today",
    purpose: "Plan the day, work through it, then shut it down.",
    icon: CalendarDays,
    group: "neuralflow",
  },
  {
    href: "/command-center/relationships/people",
    label: "People",
    purpose: "Everyone you know, with companies from their roles.",
    icon: Users,
    group: "command-center",
  },
  {
    href: "/command-center/integrations",
    label: "Connectors",
    purpose: "Wire external accounts and see what they may do.",
    icon: Unplug,
    group: "command-center",
  },
  {
    href: "/reviews",
    label: "Reviews",
    purpose: "Decide what happens next.",
    icon: ShieldCheck,
    group: "shared",
  },
  {
    href: "/activity",
    label: "Activity",
    purpose: "See what changed and why.",
    icon: Activity,
    group: "shared",
  },
  {
    href: "/command-center/spending",
    label: "Spending",
    purpose: "See what the agents have spent.",
    icon: Receipt,
    group: "shared",
  },
  {
    href: "/settings",
    label: "Settings",
    purpose: "Configure connections, models, and policies.",
    icon: Settings,
    group: "shared",
  },
];

const featureRoutes: Record<string, string> = {
  // The notes surface moved to /polymath/notes (IA simplification); the old
  // /polymath/notebook URL stays as a redirect bridge, so the prefix resolves
  // to the Notes destination for as long as that bridge exists.
  "/polymath/notebook": "/polymath/notes",
  "/command-center/relationships": "/command-center/relationships/people",
  // Reports and the stone collection moved out of the retired /apps preview;
  // both are opened from Work, which Today absorbed, so Today stays lit.
  "/neuralflow/reports": "/today",
  "/neuralflow/rewards": "/today",
  "/polymath/dossiers": "/projects",
  "/polymath/artifacts": "/artifacts",
  // Ideas became a top-level surface; the zettel, card, area and sitting
  // routes that used to live under the vault prefix forward there so an old
  // bookmark lands on Ideas rather than a 404.
  "/polymath/knowledge/zettels": "/polymath/ideas",
  "/polymath/knowledge/zettels/session": "/polymath/ideas",
  "/polymath/knowledge/ideas": "/polymath/ideas",
  "/polymath/knowledge/cards": "/polymath/ideas",
  "/polymath/knowledge/areas": "/polymath/ideas",
  // Today absorbed the five planning screens and People absorbed Companies.
  // Their routes still render (old links and the in-page links reach them);
  // only the rail changed, so each lights the entry that holds it now.
  "/neuralflow/work": "/today",
  "/neuralflow/overview": "/today",
  "/neuralflow/focus": "/today",
  "/command-center/day": "/today",
  "/command-center/shutdown": "/today",
  "/command-center/relationships/companies": "/command-center/relationships/people",
};

/**
 * The canonical address for a path: its own redirect-map entry, else the
 * longest mapped prefix (a dated day record under /command-center/day), else
 * the path itself.
 */
function canonicalPath(pathname: string): string {
  const exact = featureRoutes[pathname];
  if (exact) return exact;
  const prefix = Object.keys(featureRoutes)
    .filter((route) => pathname.startsWith(`${route}/`))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? featureRoutes[prefix] : pathname;
}

export function destinationForPath(pathname: string): Destination | undefined {
  const canonical = canonicalPath(pathname);
  const exact = destinations.find((destination) => destination.href === canonical);
  if (exact) return exact;
  return destinations
    .filter((destination) => canonical.startsWith(`${destination.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

export function isBrowserPreviewPath(pathname: string) {
  // Settings is the one screen still rendered from the browser preview
  // store (the /apps preview tools are retired and redirect to real
  // screens). Everything else reads canonical records, so it never carries
  // the preview banner (ASH-165).
  return pathname === "/settings";
}

/**
 * A conversation surface: the transcript is the page, and the shell folds to
 * it (no header bar, the sidebar collapsed to its icon rail). One definition
 * so app-shell's headerless and side-nav's auto-collapse cannot drift.
 *
 * Only the chat home and a single conversation run are immersive. Static
 * workspace pages (Notes, Vault, Skills, …) keep the shell, so a single
 * segment after /polymath/ is a run only when it is not a registered page —
 * a new static subroute under /polymath/ must be added to the set below or it
 * renders headerless.
 */
const polymathStaticSegments = new Set([
  "notes",
  "notebook",
  "ideas",
  "knowledge",
  "skills",
  "library",
  "artifacts",
  "files",
  "graph",
  "wiki",
  "sources",
  "specialists",
  "dossiers",
]);

export function isConversationSurface(pathname: string) {
  if (pathname === "/polymath") return true;
  // Guard the prefix before slicing: any other route (/command-center/inbox,
  // /neuralflow/work, /onboarding, …) is a shelled page, never a conversation.
  if (!pathname.startsWith("/polymath/")) return false;
  const rest = pathname.slice("/polymath/".length);
  if (!rest) return true;
  const [head] = rest.split("/");
  return !polymathStaticSegments.has(head);
}

/**
 * Notes is a focus surface: the reading and writing canvas is the page, so the
 * rail yields the way it does on the conversation screen. Pinning does not
 * override this — the person asked for a Notes view with no sidebar, and the
 * opener at the top-left plus `[` still reach navigation.
 */
export function isFocusSurface(pathname: string) {
  return pathname === "/polymath/notes" || pathname.startsWith("/polymath/notes/");
}

export const moreDestination = {
  href: "/more" as const,
  label: "More",
  icon: LayoutList,
};

/** Where the wordmark sends you. */
export const homeHref = "/";
