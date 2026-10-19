"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { loadPreferencesAction, savePreferencesAction } from "@/app/(workspace)/settings/actions";
import type { AppearanceValue } from "@/domains/identity/preferences";
import { Button } from "@/components/ui/button";

const choices = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

/*
 * Three explicit choices rather than a toggle: `system` is a real answer, and
 * a two-state switch cannot express it. Renders nothing until mounted because
 * the resolved theme is only known in the browser.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  // The resolved theme only exists in the browser, so the first paint is a
  // placeholder rather than a guess that would hydrate as a mismatch.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  /*
   * The account record wins only where this browser never made a choice (no
   * stored theme): that is how a new device adopts the saved appearance. An
   * explicit local choice stays, and every toggle saves back to the account.
   */
  const synced = useRef(false);
  useEffect(() => {
    if (!mounted || synced.current) return;
    synced.current = true;
    try {
      if (window.localStorage.getItem("theme")) return;
    } catch {
      return;
    }
    void loadPreferencesAction()
      .then((result) => {
        if (result.ok && result.preferences.version > 0) setTheme(result.preferences.appearance);
      })
      .catch(() => {});
  }, [mounted, setTheme]);

  if (!mounted) return <div className="size-8" aria-hidden />;

  const current = choices.find((c) => c.value === theme) ?? choices[2];
  const next = choices[(choices.indexOf(current) + 1) % choices.length];

  function persistAppearance(value: AppearanceValue) {
    void (async () => {
      const loaded = await loadPreferencesAction();
      if (!loaded.ok) return;
      await savePreferencesAction({ expectedVersion: loaded.preferences.version, appearance: value });
    })().catch(() => {});
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => { setTheme(next.value); persistAppearance(next.value); }}
      aria-label={`Theme: ${current.label}. Switch to ${next.label}.`}
      title={`Theme: ${current.label}`}
    >
      <current.icon aria-hidden className="size-4" />
    </Button>
  );
}
