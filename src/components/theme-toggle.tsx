"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
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

  if (!mounted) return <div className="size-8" aria-hidden />;

  const current = choices.find((c) => c.value === theme) ?? choices[2];
  const next = choices[(choices.indexOf(current) + 1) % choices.length];

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(next.value)}
      aria-label={`Theme: ${current.label}. Switch to ${next.label}.`}
      title={`Theme: ${current.label}`}
    >
      <current.icon aria-hidden className="size-4" />
    </Button>
  );
}
