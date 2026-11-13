import { useEffect, useRef, useState } from "react";
import { loadPreferencesAction, savePreferencesAction } from "@/app/(workspace)/settings/actions";
import { AppLauncher } from "@/components/shell/app-launcher";
import { PathBreadcrumb } from "@/components/shell/path-breadcrumb";
import { WorkspaceSwitcher, type WorkspaceSwitcherData } from "@/components/shell/workspace-switcher";
import { AppearanceMenu } from "@/components/shell/appearance-menu";
import { ModeToggle } from "@/components/shell/mode-toggle";
import { UserMenu } from "@/components/shell/user-menu";
import { CommandLayerMount } from "@/components/shell/command-layer-mount";
import { NotificationsPanel } from "@/components/shell/notifications-panel";
import { JobsIndicator } from "@/components/jobs/jobs-indicator";
import type { TriageFeed } from "@/domains/notifications/triage";
import type { ShellPreferencePatch, ShellPreferenceSnapshot } from "@/components/shell/shell-preferences";

/*
 * The header. Where-you-are on the left — the workspace names the context the
 * breadcrumb's path lives in, so the switcher sits beside the breadcrumb —
 * and what acts globally on the right: command, notifications, appearance (mode and accent), the app
 * launcher, and the account menu. The launcher sits next to the avatar,
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
  shellPreferences,
  workspaceSwitcher = null,
}: {
  clerkConfigured: boolean;
  interfaceMode?: "library" | "action";
  notifications: TriageFeed;
  shellPreferences: ShellPreferenceSnapshot;
  workspaceSwitcher?: WorkspaceSwitcherData | null;
}) {
  const [currentPreferences, setCurrentPreferences] = useState(shellPreferences);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const currentRef = useRef(currentPreferences);
  const savingRef = useRef(false);
  const fallbackScopeRef = useRef<string | null>(null);

  useEffect(() => {
    const current = currentRef.current;
    if (shellPreferences.kind === "ready") {
      if (current.kind === "unavailable" || shellPreferences.version > current.version) {
        currentRef.current = shellPreferences;
        setCurrentPreferences(shellPreferences);
      }
      return;
    }
    if (
      current.kind !== "unavailable" ||
      !shellPreferences.authenticated ||
      fallbackScopeRef.current === shellPreferences.scope
    )
      return;
    fallbackScopeRef.current = shellPreferences.scope;
    void loadPreferencesAction()
      .then((result) => {
        if (!result.ok || currentRef.current.kind !== "unavailable") return;
        const next = {
          scope: shellPreferences.scope,
          kind: "ready" as const,
          version: result.preferences.version,
          appearance: result.preferences.appearance,
          accent: result.preferences.accent,
        };
        currentRef.current = next;
        setCurrentPreferences(next);
      })
      .catch(() => {});
  }, [shellPreferences]);

  async function savePreference(patch: ShellPreferencePatch): Promise<boolean> {
    const current = currentRef.current;
    if (current.kind !== "ready" || savingRef.current) return false;
    savingRef.current = true;
    setSavingPreferences(true);
    try {
      const result = await savePreferencesAction({ expectedVersion: current.version, ...patch });
      if (result.ok) {
        const next = {
          ...current,
          version: result.preferences.version,
          appearance: result.preferences.appearance,
          accent: result.preferences.accent,
        };
        currentRef.current = next;
        setCurrentPreferences(next);
        return true;
      }
      const fresh = await loadPreferencesAction().catch(() => null);
      if (fresh?.ok) {
        const next = {
          scope: current.scope,
          kind: "ready" as const,
          version: fresh.preferences.version,
          appearance: fresh.preferences.appearance,
          accent: fresh.preferences.accent,
        };
        currentRef.current = next;
        setCurrentPreferences(next);
      }
      return false;
    } catch {
      return false;
    } finally {
      savingRef.current = false;
      setSavingPreferences(false);
    }
  }

  return (
    // While the rail is hidden, the sidebar's "Show sidebar" button sits at the
    // top left; md:pl-12 keeps the workspace switcher out from under it.
    <header className="border-border bg-background/85 sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur md:pl-12 sidebar-pinned:md:pl-3">
      <div className="flex min-w-0 items-center gap-2">
        <WorkspaceSwitcher data={workspaceSwitcher} />
        <PathBreadcrumb />
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-1 max-[420px]:gap-0.5">
        <CommandLayerMount />
        <JobsIndicator />
        <NotificationsPanel feed={notifications} />
        <ModeToggle
          resolved={interfaceMode}
          disabled={savingPreferences || currentPreferences.kind !== "ready"}
          onSave={savePreference}
        />
        <AppearanceMenu preferences={currentPreferences} disabled={savingPreferences} onSave={savePreference} />
        <AppLauncher />
        <UserMenu configured={clerkConfigured} />
      </div>
    </header>
  );
}
