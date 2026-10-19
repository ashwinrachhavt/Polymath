import type { LucideIcon } from "lucide-react";
import { products, productHref } from "@/lib/products";
import {
  Activity,
  BookOpen,
  Briefcase,
  CalendarClock,
  Compass,
  Inbox,
  LayoutList,
  MessagesSquare,
  NotebookPen,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareCheckBig,
  Target,
  Users,
  Wallet,
} from "lucide-react";

/*
 * The information architecture, in one place (product spec § The suite). The
 * switcher, the rail, the breadcrumb, and the mobile bar all read this list, so
 * a destination cannot exist in one and be missing from another.
 *
 * Three micro-apps over one system of record. The prefix is what makes the
 * boundary real: a record prepared in Command Center appears in NeuralFlow
 * without being copied, but the screens the owner navigates stay separate, and
 * a URL says which app it belongs to.
 *
 * `shared` is the fourth rail section, not a fourth app. Reviews, Activity, and
 * Settings are platform services that every app links into; they are not owned
 * by any one of the three.
 */

export type AppSlug = "command-center" | "neuralflow" | "alfred";

export type AppDefinition = {
  slug: AppSlug;
  label: string;
  /** The label the phone bar uses. A 5-across 44px strip cannot carry two words. */
  short: string;
  /** The question this app answers, in the owner's words. */
  question: string;
  /** The app's home. `/alfred` is its own root, so these are plain strings. */
  href: string;
  icon: LucideIcon;
  /**
   * The nav bar's shape. Each app owns its own, and this is the only thing
   * about an app's personality that lives in code rather than in components.
   *
   * `rail` is a full-height lateral rail: Command Center is an operations desk,
   * so its sections are always visible. `bar` is a horizontal top nav:
   * NeuralFlow and Alfred are places you read and work in, where a rail would
   * take width from the thing being worked on.
   *
   * ponytail: two shapes, no registry. A third variant arrives when a third app
   * genuinely needs a different one, not before.
   */
  nav: "rail" | "bar";
};

export const apps: AppDefinition[] = [
  {
    slug: "command-center",
    label: "Command Center",
    short: "Command",
    question: "What is happening, what do I owe, and what needs action?",
    href: "/command-center/briefing",
    icon: Compass,
    nav: "rail",
  },
  {
    slug: "neuralflow",
    label: "NeuralFlow",
    short: "NeuralFlow",
    question: "What should I work on, and how do I make progress?",
    href: "/neuralflow/work",
    icon: SquareCheckBig,
    nav: "bar",
  },
  {
    slug: "alfred",
    label: "Alfred",
    short: "Alfred",
    question: "What do I know, and what can I produce?",
    href: "/alfred",
    icon: Sparkles,
    nav: "bar",
  },
];

/**
 * The cross-app links each app offers to the other two — the "interoperable"
 * half of the suite.
 *
 * These are not "the same screen in another app"; there is no such screen. Each
 * one opens the *other* app at the record class that continues the work, which
 * is what makes a task prepared in Command Center finishable in NeuralFlow
 * without being copied. Because they are declared here rather than inside each
 * app's nav, both endpoints exist: the link out of Command Center and the
 * ability for NeuralFlow's nav to name where it came from.
 */
export type CrossAppLink = {
  from: AppSlug;
  to: AppSlug;
  /** What the owner is doing, in the owner's words. */
  label: string;
  href: string;
};

export const crossAppLinks: CrossAppLink[] = [
  {
    from: "command-center",
    to: "neuralflow",
    label: "Open in NeuralFlow",
    href: "/neuralflow/work",
  },
  {
    from: "command-center",
    to: "alfred",
    label: "Find in Alfred",
    href: "/alfred/knowledge",
  },
  {
    from: "neuralflow",
    to: "alfred",
    label: "Notes in Alfred",
    href: "/alfred/knowledge",
  },
  {
    from: "neuralflow",
    to: "command-center",
    label: "Back to Briefing",
    href: "/command-center/briefing",
  },
  {
    from: "alfred",
    to: "neuralflow",
    label: "Turn into work",
    href: "/neuralflow/work",
  },
  {
    from: "alfred",
    to: "command-center",
    label: "Back to Briefing",
    href: "/command-center/briefing",
  },
];

export function crossAppLinksFrom(slug: AppSlug) {
  return crossAppLinks.filter((link) => link.from === slug);
}

export type Destination = {
  href: string;
  label: string;
  /** What the owner does here, in the owner's words — used as the page subtitle. */
  purpose: string;
  icon: LucideIcon;
  /** Which rail cluster it sits in. The app slugs are the three apps. */
  group: AppSlug | "shared";
};

export const destinations: Destination[] = [
  {
    href: "/command-center/briefing",
    label: "Briefing",
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
    href: "/alfred",
    label: "Threads",
    purpose: "Delegate and inspect what it did.",
    icon: Sparkles,
    group: "alfred",
  },
  {
    href: "/alfred/knowledge",
    label: "Knowledge",
    purpose: "Write, retrieve, and connect.",
    icon: BookOpen,
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

export function destinationsIn(group: AppSlug | "shared") {
  return destinations.filter((d) => d.group === group);
}

const featureRoutes: Record<string, string> = {
  "/apps/command-center/briefing": "/command-center/briefing",
  "/apps/command-center/inbox": "/command-center/inbox",
  "/apps/command-center/contacts": "/command-center/relationships",
  "/apps/command-center/opportunities": "/command-center/opportunities",
  "/apps/command-center/spending": "/command-center/spending",
  "/apps/command-center/conversations": "/command-center/conversations",
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

export function additionalDestinationsIn(group: AppSlug) {
  return featureDestinations.filter((destination) => destination.group === group && !featureRoutes[destination.href]);
}

export function appForPath(pathname: string): AppDefinition | undefined {
  const segments = pathname.split("/").filter(Boolean);
  const segment = segments[0] === "apps" ? segments[1] : segments[0];
  return apps.find((app) => app.slug === segment);
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
  return pathname.startsWith("/apps/")
    || pathname.startsWith("/command-center/")
    || pathname.startsWith("/neuralflow/")
    || ["/reviews", "/activity", "/settings"].includes(pathname);
}

export const moreDestination = {
  href: "/more" as const,
  label: "More",
  icon: LayoutList,
};

/** Where the wordmark sends you when no app is more current than another. */
export const homeHref = apps[0].href;
