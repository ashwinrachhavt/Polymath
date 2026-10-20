# Polymath Design System

**Status:** Current. On 2026-10-19 the owner consolidated the product into
one flat workspace (#162) and named that merge the design direction: one
product, one rail, one accent. The register underneath it is the warm, calm
one established the same day (tokens #143, Opal reward stage #156, jewel
collection #150). This file describes that merged reality. Remaining debt is
listed in § 15.

**Precedence:** `agents/*` > `CLAUDE.md` > this file > skill defaults. This
file is the concrete instantiation of `agents/design.md`, which owns stance.
Behaviour is owned by `docs/axiom-product-spec.md`. If a rule here contradicts
either, fix it here.

---

## 1. Brief read

> **A calm, single-operator product** for one technical owner: a warm
> near-white ground, generous whitespace, one quiet charcoal accent, and
> type doing the work that chrome used to do.

The product is one flat workspace behind a single rail: a wordmark, a search
field, the destinations, and then the content, with room to breathe. It
should feel like a clear desk, not a cockpit. Every rule below is downstream
of that: sparseness is a feature, decoration is a cost, and any chrome that
competes with the content is a defect.

The one loud place is the reward register (§ 4.5): the dark Opal stage and
its stones. Loud there is the point; loud anywhere else is a bug.

## 2. Dials

| Dial | Value | Consequence |
|---|---|---|
| `DESIGN_VARIANCE` | **4** | Structured grids. Asymmetry lives in headers and the shell, never in data. |
| `MOTION_INTENSITY` | **4** | Transition, transform, opacity. Motion answers an action or celebrates a completed one. |
| `VISUAL_DENSITY` | **5** | Airy. Whitespace separates before borders do; hairlines before fills; fills before shadows. |

Overrides are conversational and per-screen. Do not edit this table to change
one screen's feel; state the override in the task instead.

## 3. One product, one accent

Polymath is one flat workspace over one record set. There is no app layer to
switch between: the rail lists the destinations directly, and everything on
screen is Polymath. The URL prefixes (`/command-center`, `/neuralflow`,
`/alfred`) remain as route organization, not as products with their own
chrome or colour.

**One accent for the whole product.** `--app-accent` aliases `--primary`
once, at the root, so components that read it keep working; nothing scopes
colour to an app. A surface that carried its own hue would make the product
look assembled from parts. This is the load-bearing rule of the whole system.

Shared routes (Reviews, Activity, Settings) are ordinary destinations in the
same rail, at its foot.

## 4. Colour

### 4.1 Ground and ink

Warm bone. Surfaces separate by the lightest hairline that still reads, then
whitespace. Never pure `#000` or `#fff`; every neutral carries a trace of
warmth (`C ≥ 0.002`, hue 75-90) so light and dark stay the same product.

| Token | Light | Dark |
|---|---|---|
| `--background` | `oklch(0.982 0.004 90)` | `oklch(0.190 0.004 80)` |
| `--card` | `oklch(0.997 0.002 90)` | `oklch(0.225 0.005 80)` |
| `--muted` | `oklch(0.960 0.004 85)` | `oklch(0.255 0.005 80)` |
| `--border` | `oklch(0.918 0.004 85)` | `oklch(0.290 0.005 80)` |
| `--foreground` | `oklch(0.27 0.008 75)` | `oklch(0.930 0.004 85)` |
| `--muted-foreground` | `oklch(0.52 0.008 78)` | `oklch(0.680 0.008 82)` |

### 4.2 The one accent

A soft warm charcoal, used the way Opal uses its dark button: primary
actions, the active nav state, the focus ring, links. Nothing else.

| Token | Light | Dark |
|---|---|---|
| `--primary` | `oklch(0.32 0.010 75)` | `oklch(0.920 0.004 85)` |
| `--primary-foreground` | `oklch(0.982 0.004 90)` | `oklch(0.240 0.006 78)` |
| `--ring` | `oklch(0.38 0.012 75)` | `oklch(0.820 0.006 85)` |

### 4.3 Status

Semantic pastels for state, from a fixed set. **Never carried by hue alone** —
a word or glyph always accompanies the colour.

| Meaning | Light bg / ink | Dark bg / ink |
|---|---|---|
| Blocked, failed | `#FDEBEC` / `#9F2F2D` | `oklch(0.30 0.05 25)` / `oklch(0.80 0.09 25)` |
| Informational | `#E1F3FE` / `#1F6C9F` | `oklch(0.29 0.05 240)` / `oklch(0.80 0.08 240)` |
| Complete, healthy | `#EDF3EC` / `#346538` | `oklch(0.29 0.05 150)` / `oklch(0.82 0.08 150)` |
| Waiting, attention | `#FBF3DB` / `#956400` | `oklch(0.31 0.05 90)` / `oklch(0.84 0.09 90)` |

### 4.4 Banned

Gradient text, neon or outer glows, more than one accent on a surface, the
beige + brass + espresso "premium consumer" family, decorative status dots,
and any colour that is the only carrier of meaning.

### 4.5 The reward register (the exception)

The focus stage and the stone collection are the one place the calm register
lifts, by design (Opal): a near-black stage with a violet halo, a photoreal
gem on a pedestal, a small-caps caption, and a big mono readout. This lives
in `.nf-stage` and `.nf-jewel` and is confined to reward surfaces: the Focus
screen, the session-complete reveal, the collection. The glow is allowed here
and only here.

## 5. Type

| Role | Family | Size | Weight |
|---|---|---|---|
| Page title | system serif (`--font-display`) | 26px | 400 |
| Section heading | Inter | 13px | 500 |
| Body, controls, tables | Inter | 13px | 400 |
| Metadata, captions | Inter | 11-12px | 400-500, small-caps for stage captions |
| Readout, IDs, keys, timers | Geist Mono | 13px (stage readouts larger) | 400 |

- **One serif role: the page title.** It marks the top of a destination. It
  never appears in body copy, labels, buttons, or tables.
- Hierarchy comes from weight and colour, not raw scale. No oversized H1s —
  the stage readout is the only big number, and it is a reward moment.
- **Every number the owner reads as instrument output is `.readout`** — mono,
  tabular figures, never for prose. A live value must not reflow as it changes.
- Line length under 80 characters for prose; line-height ≥ 1.5.

## 6. Space, shape, edge

- **4px base.** Gaps are 4, 8, 12, 16, 24, 32. Nothing else.
- **Radius ladder:** `--radius` is 8px; the ladder is 4 / 6 / 8 / 12
  (`sm / md / lg / xl`). **Full radius is reserved for chips and genuine
  status dots** (the Today's Flow quick filters are the standing chip case).
  Nav rows and buttons use the ladder, never full radius.
- **`.panel`** — 1px border + fill. Flat. No inset sheen, no per-card shadow.
- **`.panel-empty`** — same border, dashed and quieter. An invitation, not a
  failed load.
- **`.readout`** — mono + tabular figures.
- Shadows belong to layers that genuinely float (menus, dialogs, popovers)
  and are warm-tinted to the ground (`--shadow`), never grey-black. A shadow
  per card turns a grid into a contact sheet.
- Whitespace is the primary separator. 16-24px panel padding; list rows
  8-12px vertical. Target size ≥ 24px (44px on the phone bar).

## 7. Motion

- CSS transitions only until a real need for `motion` arrives. Do not install
  it in advance.
- Animate `transform` and `opacity`. Never animate layout properties.
- 120-200ms. Focus, hover, and press only.
- **Every animation must answer "what does this communicate?" in one sentence.**
  Press feedback is `scale(0.98)` or `translate-y(1px)` on `:active`.
- Reward moments are the one place delight is allowed: the forming stone, the
  stage glow, the stone reveal. Each plays once, honours
  `prefers-reduced-motion`, and is disableable in Settings.
- No scroll choreography, no pinned sections, no decorative loops, no
  fade-and-slide-up entrances per section, no hover-scale on cards.
- `useState` never tracks a continuous value.

## 8. Layout and shell

The shell is one left rail, a thin header, and the canvas.

- **The rail is the nav.** Polymath wordmark at the top, then the search
  field, then one flat list of every destination, with the shared services
  (Reviews, Activity, Settings) at the foot. The active row is a quiet fill,
  not a colour event. It collapses to an icon rail; the choice persists. The
  landmark name is "Workspace".
- **The header** carries where-you-are on the left (the breadcrumb names the
  destination in words) and the quiet global affordances on the right: the
  command layer, the reviews shield, theme, the destination launcher (a
  wayfinder for when the rail is collapsed, not a switcher), and the account
  menu.
- **The phone** hides the rail: a bottom bar with Today, Work, Library,
  Assistant, and More; the full list lives behind More.
- Desktop: flexible canvas + optional inspector (360-440px). **The inspector
  is the rule, not the exception.** Details, backlinks, activity, and Alfred
  context open beside the list so the owner never loses their place.
- CSS Grid over flex percentage math. Container max-width 1200px
  (`--page-width`). `min-h-[100dvh]`, never `h-screen`.
- Breakpoints: 640 / 768 / 1024 / 1280 / 1536.
- **Every multi-column layout declares its `< 768px` collapse in the same
  component.** No "Tailwind handles it".
- `z-index` comes from a fixed scale: `base 0`, `sticky 10`, `dropdown 20`,
  `overlay 30`, `modal 40`, `toast 50`, `skip-link 100`. Never an arbitrary
  `z-50`.

## 9. Components

Two kits currently coexist and must not grow a third.

- **Workspace kit** — `Screen`, `Panel`, `Status`, `Empty`, `Stat`, `Field`,
  `SearchField`, `Unavailable` in `src/components/workspace/ui.tsx`. Use for
  data surfaces.
- **Shell kit** — `PageHeader`, `Section` in `src/components/page-header.tsx`,
  plus shadcn primitives in `src/components/ui/`.

**Prefer an existing primitive over a new div.** Extend before inventing.
Installed today: `Badge`, `Button`, `Card`, `Dialog`, `Input`, `Select`,
`Sheet`, `Skeleton`, `Table`, `Tabs`, `Textarea`, `Tooltip`. The command
palette, popovers, scroll areas, hover cards, and `Kbd` are **not** installed;
reach for `Command` when the palette lands rather than hand-rolling one. Add
new shadcn components with the CLI (`pnpm dlx shadcn@latest add x`) so
`components.json` stays honest, then restyle through tokens. **Never ship
shadcn in its default state.**

Compose with `cva` variants and `cn()`. No boolean-prop trains, no
`style={{}}` for anything a token covers, no `!important`.

## 10. States

Every input and every data surface ships the full cycle, designed rather than
defaulted:

**loading** (a skeleton matching the final layout's shape, not a spinner),
**empty** (composed, and it says how to populate), **partial**, **stale**,
**error**, **offline**, **permission-denied**, **success**, plus default,
hover, focus-visible, active, disabled.

- Backend down renders a labelled status card — never a crash, never an empty
  list pretending success.
- Partial results render as partial. Never dress an incomplete result as whole.
- Labels sit **above** inputs; error text below. Never placeholder-as-label.
- A missing disabled state is a bug.

## 11. Copy

Owned by `agents/product.md` § Voice. The interface additions:

- **The em dash is banned in every user-visible string** — headings, labels,
  body, captions, button text, alt text. Also banned as a separator in en-dash
  form. Hyphen for compounds and ranges. A figure with no source is a hairline
  placeholder or the row is omitted — never a dash, never a fabricated `0`.
- Active voice. A button says exactly what happens ("Send email"); the toast
  repeats that word ("Email sent").
- Sentence case, plain verbs, no filler, no exclamation marks.
- Errors state what happened and how to fix it. They never apologise and never
  guess.
- An empty screen is an invitation to act, never a mood.
- No `Elevate`, `Seamless`, `Unleash`, `Next-Gen`, `Revolutionize`, `Delve`.
- No `John Doe`, `Acme Corp`, `Lorem Ipsum`. No fake-precise numbers; mock data
  is labelled as mock.
- Eyebrows rationed to one per three sections. No section numbers, version
  stamps, locale/weather strips, scroll cues, or decorative dotted metadata.
  The middle dot (`·`) appears at most once per line.

## 12. Accessibility — quality floor

WCAG 2.2 AA.

- Complete keyboard operation. A keyboard alternative for every drag
  interaction (rank changes are reachable from the inspector).
- Visible focus on every focusable element, from the global `:focus-visible`
  rule, never a component-local override.
- Stable focus order; focus returns to the trigger when an overlay closes.
- Charts and rewards carry text equivalents. The stage readout is real text,
  not part of the image.
- Any motion above intensity 3 honours `prefers-reduced-motion`. `.pulse-dot`
  stops rather than hides.
- Live regions for timers and run streaming are restrained — never a stream of
  announcements.
- Contrast checks are mandatory before ship: button label against its own
  background, placeholder/helper/error text against the section, focus ring
  against everything. The dark stage still meets AA against its own ground.

## 13. Rules (testable)

1. A screen shows at most one accent hue. The reward stage's violet glow is
   the standing exception, confined to `.nf-stage` and `.nf-jewel`.
2. No destination or surface redefines ground, type scale, radii, or spacing,
   and none carries its own accent. `--app-accent` is the one charcoal.
3. No component carries a raw hex or a Tailwind palette class (`bg-slate-800`).
4. No number in prose uses the sans face. Numbers are `.readout`.
5. Every list surface has an empty state that names the action that fills it.
6. Every mutation has a visible pending state and a visible result.
7. No user-visible string contains an em dash.
8. No screen renders an unlabelled partial result as complete.
9. Radius comes from the 4 / 6 / 8 / 12 ladder; full radius only for chips
   and status dots.
10. Every new shadcn primitive is restyled through tokens before merge.

## 14. Glossary

Use these words and no synonyms.

| Term | Means |
|---|---|
| **Capture** | Material entering the system, unprocessed. |
| **Clarify** | Converting a capture into a typed record. |
| **Outcome** | A daily commitment the owner accepted. |
| **Commit** | Moving an outcome into work. |
| **Focus session** | One durable timed session bound to one task. |
| **Review** | A decision the owner owes on a proposal. |
| **Proposal** | A prepared external write, not yet executed. |
| **Attempt** | One execution of a proposal against a provider. |
| **Run** | One durable agent execution with its own timeline. |
| **Stone** | A work memory awarded for completed focus, with a stated reason. The reward art calls it a jewel. |
| **Connector** | A connected external account. Never "connection", never "integration". |
| **Relationships** | The people-and-companies destination. Never "Contacts" as a nav label. |

## 15. Remaining debt

What still contradicts this file, in the order it should die:

| Debt | Where | Note |
|---|---|---|
| Legacy registry | `src/lib/products.ts` | Backs the workshop/preview tools (`featureDestinations`); `navigation.ts` owns the real destinations. Retire with the preview tools. |
| Preview tools | `/apps/*` | The 16 destinations' legacy paths redirect to canonical routes (#162); the workshop tools that remain should land on canonical homes or go. |
| App-era vocabulary | assorted copy | Screens and docs that still say "app", "suite", or "workspace" as a product layer should read as one Polymath. |

## 16. Open items

- **Icon family.** `lucide-react` is installed. The intended family is
  Phosphor or Tabler. One family per tree, one global `strokeWidth`, never a
  hand-rolled icon path. Migration not started.
- **Motion dependency.** `motion` is not installed. Install it when a reward
  animation needs it, not before.
- **Stone art.** Live since #156/#150: photoreal gems on the dark stage and
  in the All Jewels grid. The forming-stone progression (grey quartz to full
  colour) is the growth metaphor; keep it.
