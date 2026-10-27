import { AppLauncher } from "@/components/shell/app-launcher";
import { PathBreadcrumb } from "@/components/shell/path-breadcrumb";
import { ThemeToggle } from "@/components/theme-toggle";
import { ModeToggle } from "@/components/shell/mode-toggle";
import { UserMenu } from "@/components/shell/user-menu";
import { CommandLayer } from "@/components/shell/command-layer";
import { NotificationsPanel } from "@/components/shell/notifications-panel";
import type { NotificationFeed } from "@/domains/notifications/feed";

/*
 * The header. Where-you-are on the left (the breadcrumb names the app in
 * words); what acts globally on the right: command, notifications, theme, the
 * app launcher, and the account menu. The launcher sits next to the avatar,
 * Google-apps-style, so all "leave this app" affordances live in one corner.
 *
 * Notifications replaced the Reviews link: the panel reads the same decision
 * queue and adds runs and audit, so two entry points to one queue would be a
 * synonym, not a shortcut.
 */
export function TopBar({
  clerkConfigured,
  interfaceMode = "action",
  notifications,
}: {
  clerkConfigured: boolean;
  interfaceMode?: "library" | "action";
  notifications: NotificationFeed;
}) {
  return (
    <header className="border-border bg-background/85 sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur max-[420px]:px-4">
      <PathBreadcrumb />

      <div className="ml-auto flex min-w-0 items-center gap-1">
        <CommandLayer />
        <NotificationsPanel feed={notifications} />
        <ModeToggle resolved={interfaceMode} />
        <ThemeToggle />
        <AppLauncher />
        <UserMenu configured={clerkConfigured} />
      </div>
    </header>
  );
}
