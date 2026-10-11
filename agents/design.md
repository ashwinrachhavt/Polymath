# design.md — Visual and interaction language

**Purpose:** how Axiom looks, reads, and responds. Structure and component
inventory are owned by [axiom-product-spec.md](../docs/axiom-product-spec.md)
(§ Frontend and design); this file owns the taste.

Toolchain pin (verified against neuralflow, the closest donor):
**Tailwind v4** (CSS-first `@theme`, no `tailwind.config.js`), **shadcn/ui
`new-york`**, `baseColor: neutral`, `cssVariables: true`, **Radix** primitives,
**lucide** icons, `class-variance-authority` + `tailwind-merge` via `cn`,
**next-themes** for dark mode, React 19, Next.js 16. Components are copied into
`src/components/ui/` and owned here — no component library as a black box.

## Direction: quiet command room

A working surface, not a showcase. Calm, dense, confident, and legible after six
hours of use. It should read as *infrastructure for attention* — closer to a
well-set technical journal than to a landing page. Restraint is the personality;
the product's job is the owner's focus, and decoration competes with that.

Already decided by the spec: warm neutral light mode, graphite dark mode,
restrained cyan/teal accent, strong reading typography, high information density
without cramped controls. Never nest border-boxes; never large empty dark
surfaces.

## The honest warning about "warm neutral"

A warm near-white background with a high-contrast serif and a terracotta accent is
the single most recognisable AI-generated design of this moment. The spec's "warm
neutral" is one step away from it. So: warm must be **barely** warm (a neutral at
hue 60–80, chroma ≈ 0.005–0.01 in oklch — a paper tint, not a cream), the accent
is **cyan/teal, never clay**, and the display type is **not** a high-contrast
serif. If a screen starts looking like a design-studio sample, it has failed this
brief.

## Taste source

Three sources, in order of authority:

**1. The recorded profile — authoritative when it exists.** gstack's
`design-shotgun` writes the owner's demonstrated preferences to
`~/.gstack/projects/axiom/taste-profile.json`. If that file exists it wins on
palette, type, and motion. Read it before proposing visual variants; update it by
running `design-shotgun`, never by editing the JSON. No profile exists for this
project yet, so the rules below are the standing stance and every open item is
genuinely open.

**2. `minimalist-ui` — the primary local taste skill.** Installed from
`Leonxlnx/taste-skill` into `.claude/skills/`. Warm monochrome, typographic
contrast, flat hierarchy, muted accents, "document-style workspace" — the closest
thing in that pack to a quiet command room. Read it before any new surface.

**3. `frontend-design:frontend-design` — the anti-template check.** Its list of
generic tells (the cream/serif/terracotta cluster, the SaaS-card kit, ALL-CAPS
eyebrows, `A · B · C` meta strings, `→` on every button) is a checklist of things
to not ship. Run it as a critique pass, not a generator.

### Do not use most of the installed pack

The same install brought in `design-taste-frontend` (the pack's flagship),
`gpt-taste`, `high-end-visual-design`, `industrial-brutalist-ui`,
`imagegen-frontend-*`, and `image-to-code`. Read their own scope lines before
reaching for one:

- `design-taste-frontend` states plainly: *"Landing pages, portfolios, and
  redesigns. Not dashboards, not data tables, not multi-step product UI."* Axiom
  is exactly that excluded category. Its rules misfire here.
- `gpt-taste` and `high-end-visual-design` are Awwwards/agency landing-page
  engines — GSAP scroll-triggered pinning, massive section spacing, AIDA page
  structure. Axiom has no scroll narrative; it has tables that must stay scannable.
- `stitch-design-taste` mandates "perpetual micro-motion" and asymmetric layouts,
  which directly contradicts the restraint rule above. (Its *idea* — generating an
  agent-facing `DESIGN.md` that enforces anti-generic standards — is what this
  file already does by hand.)

This is not a criticism of the pack; it is calibrated for a different page kind.
Using the wrong one is how a calm dashboard acquires pinning scroll animations.

**Keep only what earns its place.** `minimalist-ui` is the one to read first;
`redesign-existing-projects` is useful when restyling a donor screen (T5);
`brandkit` if a real brand asset set ever appears.

## Tokens

Single source of truth: a `:root` block plus a `.dark` block in
`src/app/globals.css`, surfaced to utilities through Tailwind v4's `@theme inline`.
Semantic names only (`--background`, `--muted-foreground`, `--border`), defined in
**oklch** so lightness can be tuned without shifting hue. Components never carry
raw hex, and never a Tailwind palette class like `bg-slate-800`.

```css
:root {
  --background: oklch(0.994 0.002 85);   /* barely-warm paper, not cream */
  --foreground: oklch(0.215 0.008 75);   /* graphite, not #111 */
  --muted: oklch(0.968 0.003 85);
  --muted-foreground: oklch(0.505 0.008 75);
  --border: oklch(0.905 0.004 85);
  --accent: oklch(0.58 0.086 205);       /* restrained cyan/teal */
  --radius: 0.5rem;
}
```

- **Spacing:** 4 px base; the working set is 4/8/12/16/24/32. Density comes from
  rhythm, not from shrinking targets.
- **Radius:** 8 px controls, 12 px cards, 16 px major surfaces, 6 px inputs.
  Hierarchy is carried by radius *and* weight, never by one radius on everything.
- **Type scale:** body 14–16 px, metadata ≥12 px, a real 1.2–1.25 step for
  headings. Line length under 80 characters; line-height ≥1.5 for body.
- **Color is never the only signal.** Risk class, run state, and sync health each
  carry a word or a glyph as well as a hue.
- **Elevation:** borders establish structure; shadows indicate actual elevation.
  One soft shadow token, used only on things that truly float.

Open: the typeface. Body needs to be excellent at small sizes on long-form
reading; the display face must not be a high-contrast serif. Geist (the donor
default) is the templated answer — choose deliberately, verify the licence, and
record the pick in the taste profile. Until then, use the configured sans and do
not invent a pairing.

## shadcn rules

- Add with the CLI (`npx shadcn@latest add x`) so `components.json` stays honest;
  `new-york` style, neutral base. Restyle via tokens, not by editing generated
  internals — when a component genuinely needs new behaviour, fork it and delete
  what you did not need.
- Extend a shadcn primitive before writing a div. `Dialog`, `Popover`,
  `Sheet`, `Tooltip`, `Command`, `Table`, `Select`, `Tabs`, `ScrollArea`,
  `HoverCard` already exist.
- Compose with `cva` variants and `cn()`; no boolean-prop trains, no `style={{}}`
  for anything a token covers, no `!important`.
- Every interactive element ships all states: default, hover, focus-visible,
  active, disabled, loading, and empty/error where it holds data. A missing
  disabled state is a bug.
- Build the Axiom-specific vocabulary from spec §Components (`AppShell`,
  `NavRail`, `DataTable`, `KanbanBoard`, `RunCard`, `ReviewCard`, `Inspector`,
  `QuickCapture`, `SourceSpan`) as thin wrappers over the primitives — the spec's
  list is the component contract.

## Layout

- **Shell:** 248 px collapsible nav rail, flexible canvas, optional 360–440 px
  inspector. Tablet: icon rail + overlay inspector. Mobile: bottom nav for
  Briefing, Inbox, Work, Alfred, More.
- **The inspector is the rule, not the exception.** Details, backlinks, activity,
  and Alfred context open beside the list so the owner never loses their place.
  Full-page navigation is for changing what you are working on, not for looking
  something up.
- Left-aligned text, generous gutters, one column of attention. Cards are for
  genuinely separable things; a list is a list, not a stack of cards.
- Whitespace separates groups; it does not pad a sparse screen into looking
  finished. A dense screen is fine — a cramped one is not.

## Motion

Direct motion 120–200 ms, `ease-out`, answering a user action: opening,
expanding, confirming, reordering. A single orchestrated moment per surface beats
scattered effects. **No** fade-and-slide-up entrances per section, no hover-scale
on every card, no decorative animation — those read as generated.

Honour `prefers-reduced-motion` everywhere, always paired with the product
settings for reduced motion and disabled celebration. Timers and run streaming use
restrained `aria-live` regions, never a stream of announcements.

## Accessibility — quality floor, not a phase

WCAG 2.2 AA. Complete keyboard operation (a keyboard alternative exists for every
drag interaction, and rank changes are reachable from the inspector). Visible
focus on every focusable element. Stable focus order; focus returns to the trigger
when an overlay closes. Status never depends on color alone. Charts and rewards
carry text equivalents. Target size ≥24 px. Every feature defines loading, empty,
partial, stale, error, offline, permission-denied, and success states — and each
one is designed, not defaulted.

## Copy

Interface text is part of the design, held to the same standard as spacing. Rules
live in [product.md](product.md#voice) — active voice, sentence case, one name per
thing for the whole flow, errors that state what happened and how to fix it, empty
screens that invite action. Avoid the meta tells while writing UI copy: no
ALL-CAPS eyebrow labels, no `A · B · C` metadata strings, no `word — fragment`
labels, no `→` glued to every button.

## Working method

Design in two passes as the frontend-design skill prescribes: first a compact plan
(palette hexes, typefaces and roles, layout concept with an ASCII wireframe,
principles), then check that plan for anything you would have produced for any
similar product — revise that part *before* writing code. Then build, screenshot,
and critique: before finishing, look in the mirror and remove one accessory.

Screenshots are the review medium. `design-review` and `design-shotgun` are the
skills for a visual pass and for generating variants; run one before a design is
declared done.
