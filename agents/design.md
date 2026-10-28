# design.md — Visual and interaction language

**Purpose:** how Polymath looks, reads, and responds. Structure and component
inventory are owned by [axiom-product-spec.md](../docs/axiom-product-spec.md)
(§ Frontend and design); this file owns the taste.

## Owner direction (2026-10-17) — takes precedence over the sections below

The owner asked for Polymath to carry NeuralFlow's elegance, purposeful animation,
and the NeuralFlow stones, and for the product to tell its own story. Where the
rules below disagree, this section wins:

- **The story lives in the product, not on a marketing page.** Briefing opens
  with the loop strip (Capture, Clarify, Commit, Focus, Review, Learn): live
  counts, a plain reason, one link to the record class that continues the work,
  and the next step that needs the owner lit. No scroll narrative.
- **Animation answers an action and is allowed to delight at reward moments.**
  Completion springs, the strike line, the forming stone and the stone reveal
  are in scope. Every one honours both `prefers-reduced-motion` and the in-app
  Reduce motion and Celebrations settings, and plays once.
- **Stone art and colour are allowed inside reward surfaces only** (Focus,
  Stone collection, Work memories, the Learn beat). Everywhere else the
  one-accent rule stands. Stones are work memories with a stated reason, never
  a leaderboard or a streak that can be lost.
- **Celebration tiers:** a small tick on completion, a non-blocking card when a
  stone is earned, a full reveal reserved for milestones.
- **Styling:** `*.module.css` does not work under the current Turbopack CSS rule
  in `next.config.ts`; use a plain stylesheet with a feature prefix (`nf-`,
  `loop-`) until that rule is fixed.

## The governing skill

The installed `taste-skill` set (`.agents/skills/`, lockfile `skills-lock.json`)
is the authority for visual decisions. Where a skill rule and this file
disagree, **the skill wins** — the outcome the owner asked for on 2026-10-11.
This file's job is now to do three things the skill cannot:

1. **Read the brief for this product**, so the skill's contextual rules have
   something to fire against (§ Brief read below).
2. **Record Polymath's dial values** and the decisions already made, so the
   direction is stable between sessions.
3. **State the token and state discipline** the code is held to.

Skill map — which one governs which surface:

| Skill | Governs | Note |
|---|---|---|
| `design-taste-frontend` | The default. Brief inference, dials, colour, typography, tells, pre-flight check. | Its own §13 excludes dashboards and dense product UI. Polymath is exactly that, so its marketing-page sections (§4.7 hero, §4.8 asset strategy, §4.9 landing density, §5 scroll/GSAP, §12 block library) **do not apply**. Everything else does, and §14's pre-flight still runs. |
| `redesign-existing-projects` | Any pass over an existing screen. Scan → diagnose → fix with the audit list and fix-priority order. | The stack-agnostic audit. This is the one to run before touching a built surface. |
| `minimalist-ui` | Palette and type register for reading surfaces. | Warm monochrome, editorial. Overrides the cool base where a surface is read rather than operated. |
| `industrial-brutalist-ui` | Dense operational surfaces — tables, run timelines, telemetry. | Pick **one** of its two substrates per surface and commit; never mix. |
| `full-output-enforcement` | Any task where a partial file is a broken file. | |

Two caveats, recorded rather than routed around:

- **`gpt-taste` and the imagegen skills are out of scope.** Their own
  descriptions are AIDA landing pages, GSAP ScrollTrigger pinning, and generated
  imagery. Polymath has no scroll narrative and no marketing page; it has tables
  that stay scannable at 13px. They stay installed but unused.
- **`image-to-code` is Codex-oriented** (image-first, generate-then-implement).
  Use it only if a design task explicitly calls for generated references.

## Brief read

> Reading this as: **dense single-operator product UI** for one technical owner,
> with a **restrained instrument language**, leaning toward **Tailwind v4 +
> shadcn + Radix + Geist**, with a **cool neutral base and one desaturated
> cyan accent**.

Audience picks the aesthetic. The audience here is one person, mid-task, at a
desk, scanning a table for the third time today. That is a cockpit reading, not
a magazine reading, and it is why the skill's own exclusion of dashboards
applies and why the marketing-page half of the skill is inert here.

Reach for this read before any UI work and state it if the read has shifted.

### The three dials

| Dial | Value | Why |
|---|---|---|
| `DESIGN_VARIANCE` | **4** | Offset, not chaotic. Structured grids and tables want predictability; asymmetry is spent on section headers and the shell, never on the data. |
| `MOTION_INTENSITY` | **4** | Fluid CSS only — transition, transform, opacity. No scroll choreography, no pinned sections, no magnetic physics. Motion exists to answer a user action. |
| `VISUAL_DENSITY` | **8** | Cockpit. Tight padding, hairlines over card boxes, `font-mono` for every number. This is the dial that makes the product feel like itself. |

Overrides happen conversationally, per the skill's §1. Do not edit this table to
change a single screen's feel — raise it in the brief instead.

## Palette

Adopted from `minimalist-ui`, with the one deviation §11.C of the skill requires:
extract the existing brand colour before applying the skill's own palette rules.
Polymath's accent is already a considered single, desaturated, non-AI-purple cyan,
so it is carried forward rather than replaced.

- **Ground:** the skill's warm monochrome family. Warm bone/off-white
  (`#F7F6F3`, `#FBFBFA`) for reading and marketing-adjacent surfaces; the cooler
  near-white stays for high-density operational screens where a warm ground
  fights the tabular greys.
- **Ink:** never `#000000`. Off-black/charcoal (`#111111`, `#2F3437`), body
  line-height 1.6.
- **One accent, locked for the whole surface.** Polymath's cyan/teal. Saturation
  under 80%, used on primary actions, the focus ring, and the active-rail rule —
  nothing else. The skill's §4.2 Color Consistency Lock is absolute: a
  teal-accented screen does not sprout a blue CTA in one panel.
- **Semantic pastels** for status, from the skill's set: pale red `#FDEBEC` /
  `#9F2F2D`, pale blue `#E1F3FE` / `#1F6C9F`, pale green `#EDF3EC` / `#346538`,
  pale yellow `#FBF3DB` / `#956400`. Always paired with a word, never carried by
  hue alone.
- **Banned outright:** the AI-purple/lila glow, gradient text, neon outer glows,
  more than one accent, and the beige+brass+espresso family the skill names as
  the premium-consumer default.

**Dark mode is mandatory and is designed in the same pass**, not retrofitted.
Dual-mode by default (§6.C); respect `prefers-color-scheme` and keep the manual
toggle. Hierarchy parity across modes, no pure `#000` or `#fff`, contrast held at
AA for body and AAA for hero copy. Test in both modes before calling anything
done.

## Type

- **Sans for everything display.** Geist (in place) + Geist Mono. Geist is the
  skill's first choice and the correct register; Inter is discouraged and is
  not used. **No serif** — the skill bans it as a default and nothing in this
  brief names one. This closes the pairing question the earlier version of this
  file left open.
- Body 13px, metadata 11px, page title 15px, section heading 13px, stat readout
  20px. Line length under 80 characters; line-height ≥1.5 for prose. Headings
  tighten tracking; body text keeps normal tracking.
- **The Notion feel governs content-first surfaces** (owner direction
  2026-10-28, canonical in the Notion Design System §5 "The Notion feel"):
  reading and writing surfaces (capture, notes, briefings, documents) take
  16px body at 1.6–1.7 line-height, one ~70ch measure, 24px block rhythm,
  ≥96px page-edge breathing, and one treatment per element. The 13px cockpit
  scale above applies to operational surfaces (tables, run timelines,
  telemetry), not to prose.
- Hierarchy comes from **weight and colour, not raw scale** (§9.B). No oversized
  H1s.
- **Every number the owner reads as instrument output is `.readout`** — mono +
  tabular figures, via `<Readout>` / `<Stat>` in `src/components/readout.tsx`.
  Never for prose. A live value must not reflow as it changes.
- Italic in display type needs `leading-[1.1]` minimum where a descender is
  present (`y g j p q`); `leading-none` clips it.

## The edge, engraving, and readout

Three shared classes in `src/app/globals.css` carry the surface vocabulary.
They are the only place a border recipe is written.

- `.panel` — border + background + a 1px sheen along the top inside edge and a
  hairline shade along the bottom, plus one soft shadow. A card, an empty state,
  a stat tile, a settings row, and a table frame are all `.panel` at different
  sizes. Depth comes from the edge, never from an accent wash.
- `.panel-empty` — the same edge, dashed and quieter, for a surface holding
  nothing yet. An invitation, not a failed load.
- `.engraved` — a 1px line every 3px at ~4%, on **shell chrome only**. On a
  reading surface it is noise under the text.
- `.readout` — mono + tabular figures.

Shadows follow the skill: tinted to the background hue, never pure-black at low
opacity, and used on genuinely floating overlays only. A shadow per card makes a
grid of cards look like a contact sheet.

**Shape consistency lock (§4.4)** — one documented scale, applied everywhere:
3px inline / 4.5px controls / 6px cards / 9px overlays. Never a pill except a
genuine status dot. This is the "documented rule" that lets a mixed ladder stand.

## Icons, motion, imagery

- **Icons:** migrate to `@phosphor-icons/react` or `@tabler/icons-react`. Lucide
  is the skill's named default choice and is discouraged (§3.C); `lucide-react`
  is currently in `package.json`, so this is an open migration, not a rule
  already met. One family per tree, one global `strokeWidth`, never a hand-rolled
  icon path.
- **Motion:** the `motion` package (`motion/react`) is installed and the root
  layout wraps the tree in `MotionConfig reducedMotion="user"`
  (`src/components/motion-config.tsx`), so every JS animation honours the OS
  reduced-motion setting. Reuse its exported `motionTransition` (180ms) rather
  than declaring a local config; the in-app Reduce motion preference is not
  wired into that provider, so JS-driven animation must still read it where the
  surface owns it. Every animation
  must answer "what does this communicate?" in one sentence (§5). No fade-and-
  slide-up entrances per section, no hover-scale on every card, no decorative
  loop. Animate `transform` and `opacity` only. `useState` never tracks a
  continuous value (§3.B).
- **Imagery:** for the rare surface that needs one, use a generated or real
  asset. **Div-based fake screenshots are banned** (§4.8, §9.E) — that is the
  single most-detected tell. A preview shows a real component, not rectangles.
  Placeholders, when unavoidable, are `picsum.photos/seed/{descriptive}/{w}/{h}`.
- **Grain/noise**, if used at all, lives on a fixed `pointer-events-none`
  overlay and never on a scrolling container (§6.E).

## Layout

- **Shell:** 248px collapsible nav rail, flexible canvas, optional 360–440px
  inspector. Tablet: icon rail + overlay inspector. Mobile: bottom nav for the
  three apps plus More.
- **The launcher is the only global chrome** (product spec § The suite). It sits
  in the header; each app renders its own nav below it and picks its own shape —
  a rail in Command Center, a bar in NeuralFlow and Alfred. Nothing global lists
  another app's screens, and no app's nav contains another app's destinations.
- **One accent token, scoped per app.** Primary actions, the active nav rule, and
  the page-header cap use `--app-accent`, which the shell re-points per app. The
  ground, type scale, radii, and edge recipe never vary between apps — sameness
  there is what makes three accents read as one instrument rather than three
  themes.
- **The inspector is the rule, not the exception.** Details, backlinks,
  activity, and Alfred context open beside the list so the owner never loses
  their place. Full-page navigation changes what you are working on; it is not
  for looking something up.
- CSS Grid over flex percentage math. Container max-width around 1400px.
  `min-h-[100dvh]`, never `h-screen`. Breakpoints at 640/768/1024/1280/1536.
- **Every multi-column layout declares its `< 768px` collapse in the same
  component** (§4.7). No "Tailwind handles it".
- Whitespace separates groups; it does not pad a sparse screen into looking
  finished. Dense is fine; cramped is not. Target size ≥24px.
- `z-index` comes from a documented scale, never an arbitrary `z-50` (§6.F).

## States

Every interactive element and every data surface ships the full cycle, designed
rather than defaulted: **loading** (a skeleton matching the final layout's
shape, not a spinner), **empty** (composed, and it says how to populate),
**partial, stale, error, offline, permission-denied, success**. Plus default,
hover, focus-visible, active, disabled, loading.

- Press feedback on `:active` — `scale-[0.98]` or `translate-y-[1px]`.
- **Contrast checks are mandatory before ship** (§4.5): button label against its
  own background, placeholder/helper/error text against the section, focus rings
  against everything. AA minimum. A missing disabled state is a bug; a white
  label on a white CTA is a pre-flight failure.
- Labels sit **above** inputs, error text below. Never placeholder-as-label.
- Status never depends on colour alone — a word or glyph always accompanies the
  hue, and decorative status dots are not used (§9.F).

## Copy

The voice rules live in [product.md](product.md#voice) and are unchanged:
active voice, sentence case, one name per thing for the whole flow, errors that
state what happened and how to fix it, empty screens that invite action. The
skill adds the anti-slop layer on top:

- **The em dash is banned in every user-visible string** (§9.G — the skill's
  single most-violated tell, with no natural-language allowance): headings,
  labels, body copy, quotes, captions, button text, alt text. Also banned as a
  separator in en-dash form. Hyphen for compounds and ranges. This overrides the earlier
  "a figure with no source is an em dash" rule: **a figure with no source is a
  hairline placeholder or the row is omitted, never a typographic dash and never
  a fabricated `0`.**
- No `Elevate`, `Seamless`, `Unleash`, `Next-Gen`, `Revolutionize`, `Delve`.
  Concrete verbs only.
- No `John Doe`, `Acme Corp`, `Lorem Ipsum`. Realistic, contextual content.
- No fake-precise numbers. `47.2%` not `50%`; mock data is labelled as mock.
- **Eyebrows are rationed to one per three sections** (§9.F) — not banned as
  before, but not on every header. No section-number labels (`01 / INDEX`), no
  version stamps in a hero, no locale/time/weather strips, no scroll cues, no
  decorative dotted metadata strips, and the middle dot (`·`) is limited to one
  per line.
- Re-read every visible string before calling it done, and rewrite anything that
  reads as grammatically broken or as an LLM sounding thoughtful (§4.9).

## Accessibility — quality floor, not a phase

WCAG 2.2 AA. Complete keyboard operation, with a keyboard alternative for every
drag interaction (rank changes are reachable from the inspector). Visible focus
on every focusable element, from the `:focus-visible` rule in `globals.css` and
not from a component-local override. Stable focus order, and focus returns to
the trigger when an overlay closes. Charts and rewards carry text equivalents.
**Any motion above `MOTION_INTENSITY: 3` honours `prefers-reduced-motion`** —
`.pulse-dot` stops rather than hides, and infinite loops, parallax, and magnetic
physics collapse to static. Live regions for timers and run streaming are
restrained, never a stream of announcements. Targets ≥24px.

## Tokens

Single source of truth: a `:root` block plus a `.dark` block in
`src/app/globals.css`, surfaced to utilities through Tailwind v4's
`@theme inline`. Semantic names only (`--background`, `--muted-foreground`,
`--border`), defined in **oklch** so lightness moves without shifting hue.
Components never carry raw hex and never a Tailwind palette class like
`bg-slate-800`.

One naming collision to know: shadcn's `--accent` is a subtle *hover surface*,
not a brand colour. Polymath's cyan lives on `--primary` and `--ring`; re-pointing
`--accent` at the accent colour would flood every hover state in the product.

New shadcn components are added with the CLI (`pnpm dlx shadcn@latest add x`) so
`components.json` stays honest, then restyled through tokens and the three
shared classes. **Never ship shadcn in default state** (§9.E). Extend a primitive
before writing a div; `Dialog`, `Popover`, `Sheet`, `Tooltip`, `Command`,
`Table`, `Select`, `Tabs`, `ScrollArea`, `HoverCard`, and `Kbd` already exist.
Compose with `cva` variants and `cn()` — no boolean-prop trains, no `style={{}}`
for anything a token covers, no `!important`.

## Working method

1. **State the brief read** in one line before generating.
2. **Set the dials** from the table above, or from the brief if it overrides.
3. **Audit before touching an existing surface** — brand tokens, IA, content
   blocks, patterns to preserve, patterns to retire, current dial reading
   (`redesign-existing-projects`, and the skill's §11.B/§11.C). Preserve IA,
   copy voice, and existing accessibility wins; never silently change routes,
   nav labels, or form field names.
4. **Build, then look at it.** Screenshots are the review medium.
   `design-review` and `design-shotgun` are the skills for a visual pass and for
   variants; run one before declaring a design done. `~/.gstack/projects/axiom/taste-profile.json`
   records the owner's demonstrated preferences when it exists and is
   authoritative; update it only by running `design-shotgun`, never by editing
   the JSON.
5. **Run the skill's §14 pre-flight check**, then remove one accessory before
   finishing.

**Watch for the stale-CSS trap.** Turbopack does not always reload
`globals.css` in a long-running dev server, and the symptom is a page rendering
the *old* tokens with no error anywhere. If a token change appears to have no
effect, restart the dev server before debugging the CSS.

## Open items

- **Icon migration:** `lucide-react` → Phosphor or Tabler, one family per tree.
- **Motion dependency:** install `motion` only when a real animation need
  arrives, not in advance.
- **Warm-ground scope:** decide which operational screens take the warm
  monochrome ground and which keep the cooler near-white. Currently unresolved.
