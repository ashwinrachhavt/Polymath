"use client";

import { ACCENTS, type Accent } from "@/lib/appearance";
import { Tooltip } from "@/components/ui/tooltip";

/*
 * The accent choice as a row of colour swatches. Native radios underneath,
 * so arrow keys move the choice and a screen reader hears "Blue, radio, 5 of
 * 6"; the circle is only the face. Shared by the top-bar picker and
 * Settings > Appearance so the two can never offer different palettes.
 */
export function AccentSwatches({
  value,
  onChange,
  name = "accent",
  disabled,
}: {
  value: Accent;
  onChange: (accent: Accent) => void;
  name?: string;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex items-center gap-1.5 disabled:opacity-60" disabled={disabled}>
      <legend className="sr-only">Accent colour</legend>
      {ACCENTS.map((accent) => (
        <label key={accent.value} className="relative flex cursor-pointer">
          <input
            type="radio"
            name={name}
            value={accent.value}
            checked={value === accent.value}
            onChange={() => onChange(accent.value)}
            className="peer sr-only"
          />
          <span className="sr-only">{accent.label}</span>
          <Tooltip content={accent.label} side="bottom">
            <span
              aria-hidden
              className="size-6 rounded-full border border-[color-mix(in_oklch,var(--foreground),transparent_80%)] ring-offset-2 ring-offset-popover peer-checked:ring-2 peer-checked:ring-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-[var(--focus)]"
              style={{ background: accent.swatch }}
            />
          </Tooltip>
        </label>
      ))}
    </fieldset>
  );
}
