"use client";

import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useState, useSyncExternalStore } from "react";
import { ACCENTS, PAPERS, readAppearance, saveAppearance, type AppearanceChoice } from "@/lib/appearance";

const MODES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

const noop = () => () => {};

/*
 * Settings > Appearance: mode, page colour and accent, each a single tap that
 * applies immediately. Mode also saves to the account through onModeChange
 * (the same row the header toggle writes); paper and accent live in this
 * browser.
 */
export function AppearancePicker({ onModeChange }: { onModeChange?: (mode: "light" | "dark" | "system") => void }) {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const [choice, setChoice] = useState<AppearanceChoice | null>(null);
  const current = choice ?? (mounted ? readAppearance() : null);

  const pick = (next: Partial<AppearanceChoice>) => {
    if (!current) return;
    const merged = { ...current, ...next };
    setChoice(merged);
    saveAppearance(merged);
  };

  if (!mounted || !current) return <div className="h-40" aria-hidden />;

  const row = "flex flex-wrap items-center gap-2";
  const option = (selected: boolean) =>
    `flex h-9 items-center gap-2 rounded-md border px-3 text-body-dense transition-colors ${
      selected ? "border-foreground bg-muted" : "border-border hover:bg-muted/60"
    }`;

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-body-dense font-medium">Mode</legend>
        <div className={row}>
          {MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              aria-pressed={theme === mode.value}
              className={option(theme === mode.value)}
              onClick={() => {
                setTheme(mode.value);
                onModeChange?.(mode.value);
              }}
            >
              <mode.icon aria-hidden className="size-4" />
              {mode.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-body-dense font-medium">Page</legend>
        <div className={row}>
          {PAPERS.map((paper) => (
            <button
              key={paper.value}
              type="button"
              aria-pressed={current.paper === paper.value}
              className={option(current.paper === paper.value)}
              onClick={() => pick({ paper: paper.value })}
            >
              <span
                aria-hidden
                className="size-4 rounded-full border border-border"
                style={{ background: paper.swatch }}
              />
              {paper.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-body-dense font-medium">Accent</legend>
        <p className="text-xs text-muted-foreground">Colours the main button, selection and focus ring.</p>
        <div className={row}>
          {ACCENTS.map((accent) => (
            <button
              key={accent.value}
              type="button"
              aria-pressed={current.accent === accent.value}
              aria-label={accent.label}
              title={accent.label}
              className="flex size-9 items-center justify-center rounded-full border border-border"
              style={{ background: accent.swatch }}
              onClick={() => pick({ accent: accent.value })}
            >
              {current.accent === accent.value && (
                <Check aria-hidden className="size-4 text-white mix-blend-difference" />
              )}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
