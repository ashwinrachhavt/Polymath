# Design: Polymath

The locked system. Every Hallmark run reads this first and pages share it.
Change it on purpose; the file is the rule.

Genre: modern-minimal. Shape: app screens under a kept workspace shell.
Theme: Furrow (dealt 1/3, seed personal-workspace-knowledge-work-79fe·66919601·2026-11-05·r0), redesign depth full.
Locking this as the project's system; it supersedes the 2026-10-28 Notion-feel
register note recorded in `src/app/globals.css`.

## System

- Genre: modern-minimal
- Shape of the first page: app screen (the workspace conversation)
- Theme: Furrow — warm manila paper, near-black ink in rules, one tangerine
  signal, a grass green for what is in date
- Axes: light/grotesk-sans/warm · posture: committed · modes: light+dark

## Tokens

`src/app/globals.css` is the source of truth (Tailwind v4 CSS-first; the
shadcn aliases point at these roles). The roles:

```css
:root {
  --paper: oklch(96% 0.011 85);
  --paper-2: oklch(99.5% 0.005 85);
  --paper-3: oklch(92% 0.016 85);
  --ink: oklch(18% 0.006 60);
  --ink-2: oklch(28% 0.008 60);
  --ink-muted: oklch(44% 0.012 60);
  --rule: oklch(88% 0.013 85);
  --signal: oklch(70% 0.19 40);
  --signal-ink: oklch(18% 0.006 60);
  --signal-soft: oklch(91% 0.05 50);
  --focus: oklch(60% 0.19 40);
  --error: oklch(52% 0.19 27);
  --success: oklch(46% 0.13 150);
  --green: oklch(48% 0.11 150);
  --contour: oklch(62% 0.07 58);
  --water: oklch(48% 0.06 232);
  --hedge: oklch(50% 0.1 150);
  --sheet: oklch(99.3% 0.004 85);
  --font-display: var(--font-red-hat-display), …; /* Red Hat Display 600 */
  --font-body: var(--font-red-hat-text), …; /* Red Hat Text 400/500 */
  --font-outlier: var(--font-red-hat-mono), …; /* figures only */
  --radius: 0.625rem;
  --rule-hair: 1px;
  --shadow-panel: 0 1px 2px oklch(18% 0.006 60 / 5%), 0 14px 28px -16px oklch(18% 0.006 60 / 28%);
}
```

Dark: the same hue bands re-derived (paper L 14%, ink L 93%, accent chroma
−0.03 / L +5), elevation by lightness, shadows off. Hue never moves between
modes. Status wheel: `--tone-attention` (sienna-amber), `--tone-teal`,
`--tone-violet`, each with a `-wash`, quiet at every chroma. Identity tints
`--avatar-1…6` with `-ink` foregrounds: six quiet hue-anchored pairs
(slate-blue, grass, sienna, plum, violet, teal) for deterministic per-person
avatars; every ink clears AA on its own wash in both modes (>= 4.5:1).

## Type

- Display: Red Hat Display 600, tracking −0.035em, sentence case.
- Body/UI: Red Hat Text 400, 500 for row titles; the app ramp
  (11–28px named `--text-data` … `--text-display`) stays.
- Figures: Red Hat Mono, tabular — readouts, ids, dates, counts (`.readout`).
  Never mono on a label, a chip or a head.
- Labels, chips, tabs: body face, a step smaller, sentence case, untracked.
  Tracked caps and eyebrows are retired (gates 54, 67).

## Controls

- Primary: tangerine fill with ink on it (`--primary/--primary-foreground`),
  radius 6–10px, min-height 32–40px in the dense app range, 44px hit target.
- Secondary: sheet fill with a 1px rule border. Active sinks 1px.
- Every control carries all eight states; focus is an instant 2px ring at
  `--focus`.

## Motion

- Character: calm. State, never decoration — `--dur-micro`/`--dur-short`,
  transforms and opacity only, no `transition: all`.
- Under reduced motion everything ends at once.

## Surfaces

- Paper ground; a card is `--sheet` with a 1px `--rule` border (`.panel`);
  only cards and floating layers lift.
- Ruled lists: a 1px ink rule over a list, hairlines between rows, a 2px ink
  rule over a total. Density is the design: tables before cards.
- Tangerine marks the primary action, the current selection and state —
  nothing else.

## Exports

Tokens live in `src/app/globals.css` (`:root`, `@theme inline`, `.dark`).
Fonts load via next/font in `src/app/layout.tsx`.
