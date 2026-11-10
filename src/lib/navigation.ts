import type { LucideIcon } from "lucide-react";
import { products, productHref } from "@/lib/products";
import {
  Activity,
  BookOpen,
  Briefcase,
  CalendarDays,
  GraduationCap,
  Inbox,
  Layers,
  LayoutDashboard,
  LayoutList,
  Library,
  ScanEye,
  Lightbulb,
  Moon,
  NotebookPen,
  Puzzle,
  Receipt,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareCheckBig,
  Timer,
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

export type AppSlug = "command-center" | "neuralflow" | "polymath";

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
    href: "/neuralflow/work",
    label: "Work",
    purpose: "Execute your commitments.",
    icon: SquareCheckBig,
    group: "neuralflow",
  },
  {
    href: "/neuralflow/overview",
    label: "Overview",
    purpose: "See project progress and the shape of your work.",
    icon: LayoutDashboard,
    group: "neuralflow",
  },
  {
    href: "/neuralflow/focus",
    label: "Focus",
    purpose: "Run a strict focus session.",
    icon: Timer,
    group: "neuralflow",
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
    href: "/command-center/relationships/people",
    label: "People",
    purpose: "Everyone you know, with companies from their roles.",
    icon: Users,
    group: "command-center",
  },
  {
    href: "/command-center/relationships/companies",
    label: "Companies",
    purpose: "The organizations your people belong to.",
    icon: Briefcase,
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
    href: "/command-center/day",
    label: "Day",
    purpose: "Review one day's record.",
    icon: CalendarDays,
    group: "command-center",
  },
  {
    href: "/command-center/shutdown",
    label: "Shut down",
    purpose: "Close the day and seed tomorrow.",
    icon: Moon,
    group: "command-center",
  },
  {
    href: "/supervision",
    label: "Supervision",
    purpose: "See what the agent is doing and what needs a person.",
    icon: ScanEye,
    group: "shared",
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
  "/apps/command-center/briefing": "/neuralflow/work?view=today",
  "/apps/command-center/inbox": "/command-center/inbox",
  "/apps/command-center/contacts": "/command-center/relationships/people",
  "/command-center/relationships": "/command-center/relationships/people",
  "/apps/command-center/conversations": "/command-center/conversations",
  "/apps/command-center/integrations": "/command-center/integrations",
  "/apps/command-center/reviews": "/reviews",
  "/apps/command-center/activity": "/activity",
  "/apps/command-center/settings": "/settings",
  "/apps/neuralflow/tasks": "/neuralflow/work",
  "/apps/polymath/dossiers": "/projects",
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
};

export const featureDestinations: Destination[] = products.flatMap((product) =>
  product.destinations.map((destination) => ({
    href: productHref(product, destination.slug),
    label: destination.label,
    purpose: destination.description,
    icon: destination.icon,
    group: product.id,
  })),
);

/** Preview tools: reachable from More and the command layer, not the rail. */
export function additionalDestinationsIn(group: AppSlug) {
  return featureDestinations.filter((destination) => destination.group === group && !featureRoutes[destination.href]);
}

export function destinationForPath(pathname: string): Destination | undefined {
  const canonical = featureRoutes[pathname] ?? pathname;
  const exact =
    destinations.find((destination) => destination.href === canonical) ??
    featureDestinations.find((destination) => destination.href === pathname);
  if (exact) return exact;
  return destinations
    .filter((destination) => canonical.startsWith(`${destination.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

export function isBrowserPreviewPath(pathname: string) {
  // The browser preview lives under /apps/ plus the shared screens still
  // rendered from the preview store. Everything under a historic prefix
  // (/command-center, /neuralflow, /polymath), /reviews and /activity read
  // canonical records, so they never carry the preview banner (ASH-165).
  return pathname.startsWith("/apps/") || pathname === "/settings";
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

/*
 * A focus page hides the app rail so the page owns the full width: the note,
 * a learning session, a single conversation, a source being read. The rail
 * peeks from the left edge and can be pinned (see side-nav.tsx). List and
 * overview pages (Home, Inbox, the Notebook list, People, Today) are not
 * focus pages. The chat home keeps its folded icon rail; only a run is focus.
 */
const focusSurfacePatterns = [
  /^\/polymath\/notes$/,
  /^\/projects\/[^/]+\/notebook\/(flashcards|explain|graph)$/,
  /^\/learn\/[^/]+$/,
  /^\/command-center\/conversations\/[^/]+$/,
  /^\/polymath\/library\/[^/]+$/,
];

export function isFocusSurface(pathname: string) {
  if (pathname !== "/polymath" && isConversationSurface(pathname)) return true;
  return focusSurfacePatterns.some((pattern) => pattern.test(pathname));
}

export const moreDestination = {
  href: "/more" as const,
  label: "More",
  icon: LayoutList,
};

/** Where the wordmark sends you. */
export const homeHref = "/";
