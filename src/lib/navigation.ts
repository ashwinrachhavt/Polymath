import type { LucideIcon } from "lucide-react";
import { products, productHref } from "@/lib/products";
import {
  Activity,
  BookOpen,
  Bot,
  Briefcase,
  CalendarClock,
  Inbox,
  LayoutList,
  Library,
  MessagesSquare,
  NotebookPen,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareCheckBig,
  Target,
  Unplug,
  Users,
  Wallet,
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

export type AppSlug = "command-center" | "neuralflow" | "alfred";

export type Destination = {
  href: string;
  label: string;
  /** What the owner does here, in the owner's words — used as the page subtitle. */
  purpose: string;
  icon: LucideIcon;
  group: AppSlug | "shared";
};

export const destinations: Destination[] = [
  {
    href: "/command-center/briefing",
    label: "Today",
    purpose: "Decide what to do today.",
    icon: Target,
    group: "command-center",
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
    href: "/neuralflow/focus",
    label: "Focus",
    purpose: "Work on one thing.",
    icon: CalendarClock,
    group: "neuralflow",
  },
  {
    href: "/alfred/knowledge",
    label: "Library",
    purpose: "Write, retrieve, and connect.",
    icon: BookOpen,
    group: "alfred",
  },
  {
    href: "/alfred",
    label: "Assistant",
    purpose: "Hand off work and inspect what it did.",
    icon: Sparkles,
    group: "alfred",
  },
  {
    href: "/alfred/wiki",
    label: "Wiki",
    purpose: "The maintained layer over your documents.",
    icon: Library,
    group: "alfred",
  },
  {
    href: "/alfred/dossiers",
    label: "Dossiers",
    purpose: "Research with a bounded set of sources.",
    icon: NotebookPen,
    group: "alfred",
  },
  {
    href: "/alfred/specialists",
    label: "Specialists",
    purpose: "Hire an agent for the job.",
    icon: Bot,
    group: "alfred",
  },
  {
    href: "/command-center/relationships",
    label: "Relationships",
    purpose: "Keep track of people and companies.",
    icon: Users,
    group: "command-center",
  },
  {
    href: "/command-center/opportunities",
    label: "Opportunities",
    purpose: "Track what you are pursuing.",
    icon: Briefcase,
    group: "command-center",
  },
  {
    href: "/command-center/spending",
    label: "Spending",
    purpose: "See what paid work costs.",
    icon: Wallet,
    group: "command-center",
  },
  {
    href: "/command-center/conversations",
    label: "Conversations",
    purpose: "Pick up agent threads where you left them.",
    icon: MessagesSquare,
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
    href: "/settings",
    label: "Settings",
    purpose: "Configure connections, models, and policies.",
    icon: Settings,
    group: "shared",
  },
];

const featureRoutes: Record<string, string> = {
  // The notebook has no nav entry of its own; it is a Library surface
  // (same artifact tables), so the nav and breadcrumb name Library, not
  // the prefix-matched Assistant (ASH-167).
  "/alfred/notebook": "/alfred/knowledge",
  "/apps/command-center/briefing": "/command-center/briefing",
  "/apps/command-center/inbox": "/command-center/inbox",
  "/apps/command-center/contacts": "/command-center/relationships",
  "/apps/command-center/opportunities": "/command-center/opportunities",
  "/apps/command-center/spending": "/command-center/spending",
  "/apps/command-center/conversations": "/command-center/conversations",
  "/apps/command-center/integrations": "/command-center/integrations",
  "/apps/command-center/reviews": "/reviews",
  "/apps/command-center/activity": "/activity",
  "/apps/command-center/settings": "/settings",
  "/apps/neuralflow/tasks": "/neuralflow/work",
  "/apps/neuralflow/focus": "/neuralflow/focus",
  "/apps/alfred/dossiers": "/alfred/dossiers",
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

/** Which historic prefix a path belongs to. Route resolution only; not UI. */
export function appForPath(pathname: string): { slug: AppSlug } | undefined {
  const segments = pathname.split("/").filter(Boolean);
  const segment = segments[0] === "apps" ? segments[1] : segments[0];
  if (segment === "command-center" || segment === "neuralflow" || segment === "alfred") {
    return { slug: segment };
  }
  return undefined;
}

export function destinationForPath(pathname: string): Destination | undefined {
  const canonical = featureRoutes[pathname] ?? pathname;
  const exact = destinations.find((destination) => destination.href === canonical)
    ?? featureDestinations.find((destination) => destination.href === pathname);
  if (exact) return exact;
  return destinations
    .filter((destination) => canonical.startsWith(`${destination.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

export function isBrowserPreviewPath(pathname: string) {
  // The browser preview lives under /apps/ plus the shared screens still
  // rendered from the preview store. Everything under a historic prefix
  // (/command-center, /neuralflow, /alfred) and /reviews read canonical
  // records, so they never carry the preview banner (ASH-165).
  return pathname.startsWith("/apps/")
    || ["/activity", "/settings"].includes(pathname);
}

export const moreDestination = {
  href: "/more" as const,
  label: "More",
  icon: LayoutList,
};

/** Where the wordmark sends you. */
export const homeHref = "/command-center/briefing";
