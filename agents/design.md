# design.md — Visual and interaction language

**Purpose:** how Axiom looks, reads, and responds. Structure and component
inventory are owned by [axiom-product-spec.md](../docs/axiom-product-spec.md)
(§ Frontend and design); this file owns the taste.

Toolchain pin (verified against neuralflow, the closest donor):
**Tailwind v4** (CSS-first `@theme`, no `tailwind.config.js`), **shadcn**
(`radix-nova` style, `baseColor: neutral`, `cssVariables: true`), **Radix**
primitives, **lucide** icons, `class-variance-authority` + `tailwind-merge` via
`cn`, **next-themes** for dark mode, React 19, Next.js 16. Components are copied
into `src/components/ui/` and owned here — no component library as a black box.

## Direction: the machined console

A control surface for one person's attention, built like an instrument rather
than a document. The reference set is lab equipment, mixing desks, and flight
deck panels: black-anodised aluminium, engraved legends, one lit indicator when
something is actually on, hairlines instead of boxes, and numbers set in a face
that does not move when the number changes.

Three shared traits of the two references this direction was drawn from
(the operator's visual intent, and the design language of gamut.so as actually
inspected — see § References below). What survives from both is restraint:
near-zero chrome, no decorative colour, state carried by a word as well as a
hue.

Spend the boldness in **one** place: the panel edge. Everything else is quiet.

## The honest warning

The generated-design default of the moment is a warm cream ground with a
high-contrast serif and a terracotta accent. The machined console is one step
away from it in the same way "warm neutral" was: get the hue or the accent
wrong and the result is a design-studio sample, not an instrument. So:

- **The ground is cool, not warm.** Hue ~252, chroma ≤ 0.006. A warm ground
  plus a near-black ink plus a mono face is a recognisable genre, and this
  product is not that genre.
- **The accent is cyan/teal, never clay**, and it is used on ~3% of the
  surface: primary actions, the focus ring, the active-rail rule, and nothing
  else. An accent that appears on every card is a theme, not an accent.
- **The display face is not a high-contrast serif**, and headings are weight
  400–500, never 700. Instrument legends are not bold.
- **No gradient washes.** The only permitted gradients are light gradients —
  a 4% white-to-black ramp across a control's face, a sheen along a panel's top
  edge. A gradient used as decoration is a tell.
- **Never a large empty dark surface.** Density is the product. An empty panel
  in this direction gets a hairline and a next action, not a void.

## References, and what was taken from each

**gamut.so** (inspected live, 2026-10-11). Its actual design language
contradicts the "metallic" description in the brief: it is light-mode-first
(`#fcfcfb`), softly rounded (11–32px radii), shadowless, and built from
hairline-bordered white cards. It is friendly, well-lit SaaS — not a precision
instrument. What was worth taking, and was taken:

- **Geist Mono for machine facts.** Timestamps, tool names, file paths, IDs,
  and keyboard hints are set in mono against a quiet neutral ground. This is
  the site's single strongest motif and it is the one that belongs here; it is
  Axiom's `.readout`.
- **One accent, used once.** Every CTA on that site is the same flat
  `#0099ff`; nothing else is coloured except semantic status. Axiom keeps the
  discipline and uses a darker, less saturated cyan at hue 215.
- **Status as a word plus a colour.** Their audit log never relies on hue.
- **Discipline about what *not* to do:** no ALL-CAPS eyebrows, no `A · B · C`
  meta strings, no `→` glued to buttons, no grain, no gradient borders — their
  stylesheet contains none of these, and neither does ours.

**Explicitly not taken from gamut.so:** its roundness (12–32px), its
soft-shadowless flatness, its warm near-white ground (`#fcfcfb` is the warm
tell), and its marketing-page density. Those are what the brief's "sharp
metallic" overrides.

**The operator's intent** supplies the rest: sharp radii, the lit edge, the
engraving, and mono readouts as a system rather than a garnish.

## The recorded taste profile

`~/.gstack/projects/axiom/taste-profile.json` is authoritative when it exists —
it records the owner's *demonstrated* preferences rather than an asserted
stance. Read it before proposing visual variants; update it by running
`design-shotgun`, never by editing the JSON. **No profile exists for this
project yet**, so everything below is the standing stance and every open item
is genuinely open.

### Landing-page design packs are out of scope

Several popular "taste" skill packs (`design-taste-frontend`, `gpt-taste`,
`high-end-visual-design`) state their own scope as landing pages, portfolios,
and redesigns — one of them explicitly excludes "dashboards, data tables,
multi-step product UI." Axiom is entirely that excluded category. Those packs
drive GSAP scroll-triggered pinning, massive section spacing, and AIDA page
structure; Axiom has no scroll narrative, it has tables that must stay
scannable at 13px. Do not install them here. What was worth keeping from that
family is folded in above: monochrome, typographic contrast, flat hierarchy,
muted accents, no gradients, no heavy shadows.

## Tokens

Single source of truth: a `:root` block plus a `.dark` block in
`src/app/globals.css`, surfaced to utilities through Tailwind v4's `@theme
inline`. Semantic names only (`--background`, `--muted-foreground`, `--border`),
defined in **oklch** so lightness can be tuned without shifting hue. Components
never carry raw hex, and never a Tailwind palette class like `bg-slate-800`.

```css
:root {
  --radius: 0.375rem;                    /* 6px — the ladder's midpoint */
  --background: oklch(0.984 0.002 252);  /* cool near-white, not paper */
  --foreground: oklch(0.195 0.008 255);  /* near-black, cool */
  --muted-foreground: oklch(0.492 0.008 255);
  --border: oklch(0.898 0.004 252);
  --primary: oklch(0.5 0.09 215);        /* instrument cyan/teal */
}
.dark {
  --background: oklch(0.185 0.005 255);  /* the machined default */
  --card: oklch(0.215 0.005 255);
  --edge-light: oklch(1 0 0 / 7%);       /* sheen is far weaker in dark */
}
```

### The edge — the one signature move

`--edge-light` and `--edge-shade` are 1px inner lines: a sheen along a panel's
top inside edge, a hairline shade along its bottom inside edge. That pair is
what makes a rectangle read as a milled plate catching light from above rather
than as a filled box, and it is the difference between this direction and a
generic dark dashboard.

It is applied through **one class**, `.panel` in `globals.css`:

- `.panel` — border + card background + edge pair + one soft shadow.
- `.panel-empty` — the same edge, dashed and half-opaque, for a surface that
  holds nothing yet. Same object, waiting for its part.

A card, an empty state, a stat readout, a settings row, an outlined button, and
a table frame are all `.panel` at different sizes. Do not write a local border
recipe; if a surface needs one, it is a variant of `.panel`.

`.engraved` is the second shared class: a 1px line every 3px at ~4%, applied to
**shell chrome only** (rail, header, mobile bar). On a reading surface it is
noise under the text.

`.readout` is the third: mono + tabular figures, via `<Readout>` and `<Stat>` in
`src/components/readout.tsx`. Use it for every number the owner reads as
instrument output — counts, timers, spend, run ids, state labels. Never for
prose. Live values must not reflow.

### Scale

- **Radius ladder:** 3px (`sm`, inline) / 4.5px (`md`, controls) / 6px (`lg`,
  cards) / 9px (`xl`, major surfaces and overlays). Never a pill except a
  genuine status dot. The upstream registry defaults to 8px controls and
  `rounded-4xl` badges; both were cut.
- **Spacing:** 4px base; the working set is 4/8/12/16/24/32. Density comes from
  rhythm, not from shrinking targets. Target size stays ≥24px.
- **Type:** body **13px**, metadata **11px**, page title **15px**, section
  heading **13px**, stat readout **20px** (or `text-3xl` for a lone timer).
  Headings carry `--tracking-tight` (-0.011em); body text does not. Line
  length under 80 characters; line-height ≥1.5 for body prose.
- **Colour is never the only signal.** Risk class, run state, and sync health
  each carry a word or a glyph as well as a hue.
- **Elevation:** `.panel`'s edge establishes structure; `--shadow` is used on
  genuinely floating overlays only. A shadow per card makes a grid of cards
  look like a contact sheet.

**Open: the typeface.** Geist is in place and is the right *register* — a
low-contrast grotesque with flat terminals reads correctly as instrument
labelling — but it is also the templated answer, and the pairing question
(does the display face need to differ from the mono?) is unresolved. Choose
deliberately, verify the licence, and record the pick in the taste profile.
Until then, do not invent a pairing.

## shadcn rules

- Add with the CLI (`pnpm dlx shadcn@latest add x`) so `components.json` stays
  honest; `radix-nova` style, neutral base. Restyle via tokens and the three
  shared classes — when a component genuinely needs new behaviour, fork it and
  delete what you did not need.
- Extend a shadcn primitive before writing a div. `Dialog`, `Popover`, `Sheet`,
  `Tooltip`, `Command`, `Table`, `Select`, `Tabs`, `ScrollArea`, `HoverCard`,
  `Kbd` already exist.
- Compose with `cva` variants and `cn()`; no boolean-prop trains, no
  `style={{}}` for anything a token covers, no `!important`.
- Every interactive element ships all states: default, hover, focus-visible,
  active, disabled, loading, and empty/error where it holds data. A missing
  disabled state is a bug.
- Build the Axiom-specific vocabulary from spec §Components (`AppShell`,
  `NavRail`, `DataTable`, `KanbanBoard`, `RunCard`, `ReviewCard`, `Inspector`,
  `QuickCapture`, `SourceSpan`) as thin wrappers over the primitives — the
  spec's list is the component contract.

## Layout

- **Shell:** 248px collapsible nav rail, flexible canvas, optional 360–440px
  inspector. Tablet: icon rail + overlay inspector. Mobile: bottom nav for
  Briefing, Inbox, Work, Alfred, More.
- **The inspector is the rule, not the exception.** Details, backlinks,
  activity, and Alfred context open beside the list so the owner never loses
  their place. Full-page navigation is for changing what you are working on,
  not for looking something up.
- Left-aligned text, generous gutters, one column of attention. A list is a
  list — not a stack of cards.
- Whitespace separates groups; it does not pad a sparse screen into looking
  finished. A dense screen is fine — a cramped one is not.
- Headings act as **engraved legends**, not as display type: small, medium
  weight, tight-tracked, sitting directly above the thing they label. Do not
  scale a heading up to signal importance; use position and the rule.

## Motion

Direct motion 120–200ms, `ease-out`, answering a user action: opening,
expanding, confirming, reordering. **No** fade-and-slide-up entrances per
section, no hover-scale on every card, no decorative animation. The one
non-user-triggered motion is the live-run indicator (`.pulse-dot`), and it is
reserved for something genuinely running.

Honour `prefers-reduced-motion` everywhere — `.pulse-dot` stops rather than
hides — always paired with the product settings for reduced motion and disabled
celebration. Timers and run streaming use restrained `aria-live` regions, never
a stream of announcements.

## Accessibility — quality floor, not a phase

WCAG 2.2 AA. Complete keyboard operation (a keyboard alternative exists for
every drag interaction, and rank changes are reachable from the inspector).
Visible focus on every focusable element. Stable focus order; focus returns to
the trigger when an overlay closes. Status never depends on color alone. Charts
and rewards carry text equivalents. Target size ≥24px. Every feature defines
loading, empty, partial, stale, error, offline, permission-denied, and success
states — and each one is designed, not defaulted.

## Copy

Interface text is part of the design, held to the same standard as spacing.
Rules live in [product.md](product.md#voice) — active voice, sentence case, one
name per thing for the whole flow, errors that state what happened and how to
fix it, empty screens that invite action. Avoid the meta tells while writing UI
copy: no ALL-CAPS eyebrow labels, no `A · B · C` metadata strings, no
`word — fragment` labels, no `→` glued to every button. A figure with no source
is an em dash, never a fabricated `0`.

## Working method

Design in two passes as the frontend-design skill prescribes: first a compact
plan (palette hexes, typefaces and roles, layout concept with an ASCII
wireframe, principles), then check that plan for anything you would have
produced for any similar product — revise that part *before* writing code.
Then build, screenshot, and critique: before finishing, look in the mirror and
remove one accessory.

Screenshots are the review medium. `design-review` and `design-shotgun` are the
skills for a visual pass and for generating variants; run one before a design is
declared done.

**Watch for the stale-CSS trap.** Turbopack does not always reload
`globals.css` in a long-running dev server, and the symptom is a page that
renders the *old* tokens with no error anywhere. If a token change appears to
have no effect, restart the dev server before debugging the CSS.
