import {
  Briefcase,
  CalendarClock,
  CalendarDays,
  Cloud,
  Contact,
  CreditCard,
  Database,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  HardDrive,
  Mail,
  MessageCircle,
  MessageSquare,
  MessageSquareCode,
  Palette,
  SquareKanban,
  UserRound,
  Video,
} from "lucide-react";

/*
 * Provider marks for the connector catalog and the chat's tool activity.
 *
 * DESIGN.md bans per-product colour ("one accent for the whole product"), so
 * these are monochrome glyphs inside the existing .product-mark tile, not
 * brand-coloured logos: the tile carries the recognition, and the accent stays
 * a single quiet charcoal. An unknown provider falls back to its initial, which
 * is what every provider used before this map existed.
 */
const ICONS: Record<string, typeof Mail> = {
  gmail: Mail,
  "google-calendar": CalendarDays,
  "google-drive": FolderOpen,
  "google-docs": FileText,
  "google-sheets": FileSpreadsheet,
  slack: MessageSquare,
  discord: MessageCircle,
  zoom: Video,
  calendly: CalendarClock,
  notion: FileText,
  github: MessageSquareCode,
  linear: SquareKanban,
  jira: SquareKanban,
  asana: SquareKanban,
  trello: SquareKanban,
  airtable: Database,
  figma: Palette,
  canva: Palette,
  dropbox: HardDrive,
  hubspot: Contact,
  salesforce: Cloud,
  stripe: CreditCard,
  // Not shipped, but the catalog may still show a row for a provider added
  // before its config existed.
  vercel: Briefcase,
  people: UserRound,
};

export function ProviderIcon({ provider, displayName }: { provider: string; displayName: string }) {
  const Icon = ICONS[provider];
  if (!Icon) return <>{displayName.slice(0, 1)}</>;
  return <Icon aria-hidden className="size-4" />;
}

/** Tool name to a readable label and glyph for chat tool activity. */
export function toolGlyph(toolName: string) {
  if (toolName.startsWith("documents") || toolName.startsWith("documents.")) return FileText;
  // Gmail now arrives as `polymath-gateway__gmail_search` (an MCP connection
  // tool), and capability labels still read `gmail.…`.
  if (toolName.includes("gmail")) return Mail;
  if (toolName.startsWith("calendar")) return CalendarDays;
  if (toolName.startsWith("notion") || toolName.startsWith("wiki")) return FileText;
  return MessageSquare;
}
