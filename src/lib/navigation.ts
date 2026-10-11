import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BookOpen,
  Briefcase,
  CalendarClock,
  Inbox,
  LayoutList,
  NotebookPen,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareCheckBig,
  Target,
  Users,
} from "lucide-react";

/*
 * The information architecture, in one place (product spec § Information
 * architecture). The rail, the command palette, and the mobile bar all read
 * this list, so a destination cannot exist in one and be missing from another.
 *
 * `primary` marks the four that also fit the mobile bottom bar; the rest live
 * behind More.
 */

export type Destination = {
  href: string;
  label: string;
  /** What the owner does here, in the owner's words — used as the page subtitle. */
  purpose: string;
  icon: LucideIcon;
  primary?: boolean;
  /** Grouping in the rail. */
  group: "Daily" | "Execute" | "Knowledge" | "System";
};

export const destinations: Destination[] = [
  {
    href: "/briefing",
    label: "Briefing",
    purpose: "Decide what to do today.",
    icon: Target,
    primary: true,
    group: "Daily",
  },
  {
    href: "/inbox",
    label: "Inbox",
    purpose: "Clarify what arrived.",
    icon: Inbox,
    primary: true,
    group: "Daily",
  },
  {
    href: "/work",
    label: "Work",
    purpose: "Execute your commitments.",
    icon: SquareCheckBig,
    primary: true,
    group: "Execute",
  },
  {
    href: "/focus",
    label: "Focus",
    purpose: "Work on one thing.",
    icon: CalendarClock,
    group: "Execute",
  },
  {
    href: "/alfred",
    label: "Alfred",
    purpose: "Delegate and inspect what it did.",
    icon: Sparkles,
    primary: true,
    group: "Execute",
  },
  {
    href: "/reviews",
    label: "Reviews",
    purpose: "Decide what happens next.",
    icon: ShieldCheck,
    group: "Execute",
  },
  {
    href: "/knowledge",
    label: "Knowledge",
    purpose: "Write, retrieve, and connect.",
    icon: BookOpen,
    group: "Knowledge",
  },
  {
    href: "/relationships",
    label: "Relationships",
    purpose: "Keep track of people and companies.",
    icon: Users,
    group: "Knowledge",
  },
  {
    href: "/opportunities",
    label: "Opportunities",
    purpose: "Track what you are pursuing.",
    icon: Briefcase,
    group: "Knowledge",
  },
  {
    href: "/dossiers",
    label: "Dossiers",
    purpose: "Research with a bounded set of sources.",
    icon: NotebookPen,
    group: "Knowledge",
  },
  {
    href: "/activity",
    label: "Activity",
    purpose: "See what changed and why.",
    icon: Activity,
    group: "System",
  },
  {
    href: "/settings",
    label: "Settings",
    purpose: "Configure connections, models, and policies.",
    icon: Settings,
    group: "System",
  },
];

/** Order for the rail; the groups themselves are the headings. */
export const navGroups = ["Daily", "Execute", "Knowledge", "System"] as const;

/** The mobile bottom bar: Briefing, Inbox, Work, Alfred, then More. */
export const mobileDestinations = destinations.filter((d) => d.primary);

export const moreDestination = {
  href: "/more",
  label: "More",
  icon: LayoutList,
};
