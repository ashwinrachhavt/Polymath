"use client";

import { useSyncExternalStore } from "react";
import { Select } from "@/components/ui/select";

/*
 * The palette picker. Palettes (white / solar / polarized / metallic, per
 * the owner's GitHub-style ask) are colour overlays on the same tokens, so
 * switching one never moves layout. The choice is per-browser for now:
 * localStorage under "axiom-palette", mirrored onto <html data-palette>
 * before paint by the inline script in the root layout. The account
 * preference record only carries light/dark/system today; promoting
 * palette to an account preference is a separate, schema-touching change.
 */

export const PALETTES = [
  { value: "", label: "Default", note: "The warm Dao ground" },
  { value: "white", label: "White", note: "GitHub's register: pure white, cool ink, one blue" },
  { value: "solar", label: "Solar", note: "Solarized parchment / deep teal" },
  { value: "polarized", label: "Polarized", note: "High contrast: pure poles, loud borders" },
  { value: "metallic", label: "Metallic", note: "Silver light over gunmetal dark" },
] as const;

export const PALETTE_STORAGE_KEY = "axiom-palette";

const valid = new Set<string>(PALETTES.map((p) => p.value));

export function applyPalette(value: string) {
  const palette = valid.has(value) ? value : "";
  if (palette) document.documentElement.dataset.palette = palette;
  else delete document.documentElement.dataset.palette;
  try {
    if (palette) window.localStorage.setItem(PALETTE_STORAGE_KEY, palette);
    else window.localStorage.removeItem(PALETTE_STORAGE_KEY);
  } catch {
    // Private windows can refuse storage; the attribute still holds for the session.
  }
}

export function PalettePicker() {
  // Same mount gate as ThemeToggle: the stored palette only exists in the
  // browser, so render a same-sized placeholder until mounted.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  if (!mounted) return <div className="h-8 w-24" aria-hidden />;

  const current = document.documentElement.dataset.palette ?? "";

  return (
    <Select
      variant="ghost"
      className="w-24"
      value={current}
      onChange={(event) => applyPalette(event.target.value)}
      aria-label="Colour palette"
      title="Colour palette"
    >
      {PALETTES.map((palette) => (
        <option key={palette.value} value={palette.value} title={palette.note}>
          {palette.label}
        </option>
      ))}
    </Select>
  );
}
