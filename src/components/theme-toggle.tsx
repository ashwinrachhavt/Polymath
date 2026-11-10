"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LoadedPreferences } from "@/domains/identity/preferences";
import type { SaveShellPreference } from "@/components/shell/shell-preferences";
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
export function ThemeToggle({
  initialPreference,
  disabled,
  onSave,
}: {
  initialPreference: Pick<LoadedPreferences, "appearance" | "version"> | null;
  disabled: boolean;
  onSave: SaveShellPreference;
}) {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const synced = useRef(false);

  useEffect(() => {
    if (!mounted || synced.current || !initialPreference) return;
    synced.current = true;
    if (initialPreference.version === 0) return;
    try {
      if (window.localStorage.getItem("theme")) return;
    } catch {
      return;
    }
    setTheme(initialPreference.appearance);
  }, [mounted, initialPreference, setTheme]);

  if (!mounted) return <div className="size-8" aria-hidden />;

  const current = choices.find((choice) => choice.value === theme) ?? choices[2];
  const next = choices[(choices.indexOf(current) + 1) % choices.length];

  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={disabled}
      onClick={() => {
        setTheme(next.value);
        void onSave({ appearance: next.value });
      }}
      aria-label={`Theme: ${current.label}. Switch to ${next.label}.`}
      title={`Theme: ${current.label}`}
    >
      <current.icon aria-hidden className="size-4" />
    </Button>
  );
}
