"use client";

import { Monitor, Moon, Palette, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Popover } from "radix-ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "cn";
import { AccentSwatches } from "@/components/accent-swatches";
import type { SaveShellPreference, ShellPreferenceSnapshot } from "@/components/shell/shell-preferences";
import { IconButton } from "@/components/ui/icon-button";
import { toast } from "@/components/ui/toast";
import { applyAccent, readAppearance, type Accent } from "@/lib/appearance";

const MODES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

const subscribeNothing = () => () => {};

/*
 * The header's one appearance control: light/dark/system and the accent
 * swatches in a small popover. Both save to the account preference row, so
 * the phone and every other browser follow; the accent is also mirrored to
 * this browser so the boot script paints it before first frame.
 *
 * The account row wins on load: a saved accent that differs from this
 * browser's mirror (picked on another device) is applied once mounted. A
 * saved light/dark choice applies only when this browser has none of its own,
 * as before.
 */
export function AppearanceMenu({
  preferences,
  disabled,
  onSave,
}: {
  preferences: ShellPreferenceSnapshot;
  disabled: boolean;
  onSave: SaveShellPreference;
}) {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  const [accent, setAccent] = useState<Accent | null>(null);
  const synced = useRef(false);
  const saved = preferences.kind === "ready" ? preferences : null;

  useEffect(() => {
    if (!mounted || synced.current || !saved) return;
    synced.current = true;
    if (saved.version === 0) return;
    if (readAppearance().accent !== saved.accent) applyAccent(saved.accent);
    try {
      if (window.localStorage.getItem("theme")) return;
    } catch {
      return;
    }
    setTheme(saved.appearance);
  }, [mounted, saved, setTheme]);

  const current: Accent | null = accent ?? (mounted ? readAppearance().accent : null);

  async function pickAccent(next: Accent) {
    const before = current;
    setAccent(next);
    applyAccent(next);
    // Signed out (a preview deployment): the browser mirror is all there is.
    if (!saved) return;
    if (await onSave({ accent: next })) return;
    if (before) {
      setAccent(before);
      applyAccent(before);
    }
    toast("Could not save the accent. Try again.", { tone: "error" });
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton label="Appearance" icon={<Palette aria-hidden />} className="text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="panel z-50 flex w-64 flex-col gap-3 rounded-lg bg-popover p-3 text-popover-foreground outline-none"
        >
          <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
            <legend className="mb-1.5 text-xs text-muted-foreground">Mode</legend>
            <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-0.5">
              {MODES.map((mode) => {
                const selected = mounted && theme === mode.value;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setTheme(mode.value);
                      if (saved) void onSave({ appearance: mode.value });
                    }}
                    className={cn(
                      "flex h-7 items-center justify-center gap-1.5 rounded-[5px] text-xs text-muted-foreground outline-none",
                      "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                      selected && "bg-popover text-foreground shadow-sm",
                    )}
                  >
                    <mode.icon aria-hidden className="size-3.5" />
                    {mode.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground" aria-hidden>
              Accent
            </p>
            {current ? (
              <AccentSwatches
                name="accent-menu"
                value={current}
                disabled={disabled}
                onChange={(next) => void pickAccent(next)}
              />
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
