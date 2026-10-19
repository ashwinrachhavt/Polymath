# Axiom Design System

**Status:** Target. `src/app/globals.css` currently implements a narrower
register; § 15 lists the exact delta. Where this file and the code disagree,
this file is the intent and the code is the debt.

**Precedence:** `agents/*` > `CLAUDE.md` > this file > skill defaults. This
file is the concrete instantiation of `agents/design.md`, which owns stance.
Behaviour is owned by `docs/axiom-product-spec.md`. If a rule here contradicts
either, fix it here.

---

## 1. Brief read

> **Dense single-operator product UI** for one technical owner, in a
> **quiet command-room** register, leaning **warm neutral ground + one accent
> per app**, with **high information density and short motion**.

The audience is one person, mid-task, at a desk, scanning the same table for
the third time today. That is a cockpit reading, not a magazine reading. Every
rule below is downstream of that sentence: density is a feature, decoration is
a cost, and anything that slows a second pass is a defect.

## 2. Dials

| Dial | Value | Consequence |
|---|---|---|
| `DESIGN_VARIANCE` | **4** | Structured grids. Asymmetry lives in headers and the shell, never in data. |
| `MOTION_INTENSITY` | **4** | Transition, transform, opacity. Motion answers an action or celebrates a completed one. |
| `VISUAL_DENSITY` | **8** | Cockpit. Tight padding, hairlines over card boxes, mono for every number. |

Overrides are conversational and per-screen. Do not edit this table to change
one screen's feel; state the override in the task instead.

## 3. Three apps, one instrument

Axiom is three micro-app experiences over one record set.

| App | Accent | Nav shape | Why |
|---|---|---|---|
| Command Center | cyan | full-height **rail** | Operations desk; sections stay in view because you move between them constantly. |
| NeuralFlow | green | horizontal **bar** | You read and work here; a rail would take width from the material. |
| Alfred | violet | horizontal **bar** | Same. |

**The accent is the only thing that varies.** Ground, type scale, radii, edge
recipe, spacing, and control heights are identical across all three. An app
that also changed its weight or spacing would make the suite look assembled
from parts. This is the load-bearing rule of the whole system.

Shared routes (Reviews, Activity, Settings, auth) fall back to the product
accent, which is Command Center's cyan.

## 4. Colour

### 4.1 Ground and ink

Warm neutral. Surfaces separate by hairline and whitespace, not by shadow or
texture.

| Token | Light | Dark |
|---|---|---|
| `--background` | `oklch(0.975 0.005 85)` | `oklch(0.200 0.004 80)` |
| `--card` | `oklch(0.995 0.003 85)` | `oklch(0.235 0.004 80)` |
| `--muted` | `oklch(0.955 0.006 85)` | `oklch(0.260 0.005 80)` |
| `--border` | `oklch(0.900 0.006 85)` | `oklch(0.300 0.005 80)` |
| `--foreground` | `oklch(0.220 0.006 70)` | `oklch(0.930 0.004 85)` |
| `--muted-foreground` | `oklch(0.470 0.010 70)` | `oklch(0.700 0.008 82)` |

Never pure `#000` or `#fff`. Never `oklch(L 0 0)` — every neutral carries a
trace of warmth (`C ≥ 0.003`, hue 70–85) so light and dark stay the same
product.

### 4.2 Accents

One accent per app, scoped by `data-app` on the shell, read through
`--app-accent`. Primary buttons, the active nav rule, focus rings, and links
use it. Nothing else does.

| App | Light | Dark |
|---|---|---|
| Command Center | `oklch(0.55 0.10 210)` | `oklch(0.72 0.09 210)` |
| NeuralFlow | `oklch(0.52 0.11 155)` | `oklch(0.70 0.10 155)` |
| Alfred | `oklch(0.52 0.15 292)` | `oklch(0.72 0.12 292)` |

Saturation stays under 0.16 chroma. The accents are labels, not lighting.

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

## 5. Type

| Role | Family | Size | Weight |
|---|---|---|---|
| Page title | system serif (`--font-display`) | 26px | 400 |
| Section heading | Inter | 13px | 500 |
| Body, controls, tables | Inter | 13px | 400 |
| Metadata | Inter | 11–12px | 400 |
| Readout, IDs, keys | Geist Mono | 13px | 400 |

- **One serif role: the page title.** It marks the top of a destination and
  gives the suite a reading register. It never appears in body copy, labels,
  buttons, or tables. This is a deliberate deviation from the "no serif"
  default; the ceiling is that a second serif role would make the product look
  editorial rather than operational.
- Hierarchy comes from weight and colour, not raw scale. No oversized H1s.
- **Every number the owner reads as instrument output is `.readout`** — mono,
  tabular figures, never for prose. A live value must not reflow as it changes.
- Line length under 80 characters for prose; line-height ≥ 1.5.

## 6. Space, shape, edge

- **4px base.** Gaps are 4, 8, 12, 16, 24, 32. Nothing else.
- **Radius lock:** 3px inline (badges, code), 4.5px controls, 6px cards and
  panels, 9px overlays. Never a pill except a genuine status dot.
- **`.panel`** — 1px border + fill. Flat. No inset sheen, no per-card shadow.
- **`.panel-empty`** — same border, dashed and quieter. An invitation, not a
  failed load.
- **`.readout`** — mono + tabular figures.
- Shadows belong to layers that genuinely float (menus, dialogs, popovers) and
  are tinted to the ground hue, never pure-black at low opacity. A shadow per
  card turns a grid into a contact sheet.
- Density: 8–12px vertical padding on list rows, 16px on panels. Target size
  ≥ 24px. Dense is fine; cramped is not.

## 7. Motion

- CSS transitions only until a real need for `motion` arrives. Do not install
  it in advance.
- Animate `transform` and `opacity`. Never animate layout properties.
- 120–200ms. Focus, hover, and press only.
- **Every animation must answer "what does this communicate?" in one sentence.**
  Press feedback is `scale(0.98)` or `translate-y(1px)` on `:active`.
- Reward moments are the one place delight is allowed: completion springs, the
  strike line, the forming stone and the stone reveal. Each plays once, honours
  `prefers-reduced-motion`, and is disableable in Settings.
- No scroll choreography, no pinned sections, no decorative loops, no
  fade-and-slide-up entrances per section, no hover-scale on cards.
- `useState` never tracks a continuous value.

## 8. Layout and shell

- **The app launcher is the only global chrome.** It sits in the header and is
  not part of any app's navigation.
- **Each app owns its nav.** Command Center renders a rail; NeuralFlow and
  Alfred render a bar. No app's nav contains another app's destinations.
- Desktop: rail (248px, collapsible) + flexible canvas + optional inspector
  (360–440px). Tablet: icon rail + overlay inspector. Mobile: bottom bar with
  the three apps, then More.
- **The inspector is the rule, not the exception.** Details, backlinks,
  activity, and Alfred context open beside the list so the owner never loses
  their place.
- CSS Grid over flex percentage math. Container max-width 1200px
  (`--content-width`). `min-h-[100dvh]`, never `h-screen`.
- Breakpoints: 640 / 768 / 1024 / 1280 / 1536.
- **Every multi-column layout declares its `< 768px` collapse in the same
  component.** No "Tailwind handles it".
- Breadcrumbs name the app the owner crossed into.
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
- Charts and rewards carry text equivalents.
- Any motion above intensity 3 honours `prefers-reduced-motion`. `.pulse-dot`
  stops rather than hides.
- Live regions for timers and run streaming are restrained — never a stream of
  announcements.
- Contrast checks are mandatory before ship: button label against its own
  background, placeholder/helper/error text against the section, focus ring
  against everything.

## 13. Rules (testable)

1. A screen shows at most one accent hue.
2. No app redefines ground, type scale, radii, or spacing. Only `--app-accent`.
3. No component carries a raw hex or a Tailwind palette class (`bg-slate-800`).
4. No number in prose uses the sans face. Numbers are `.readout`.
5. Every list surface has an empty state that names the action that fills it.
6. Every mutation has a visible pending state and a visible result.
7. No user-visible string contains an em dash.
8. No screen renders an unlabelled partial result as complete.
9. Radius comes from the 3 / 4.5 / 6 / 9 lock.
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
| **Stone** | A work memory awarded for completed focus, with a stated reason. |
| **Connector** | A connected external account. Never "connection", never "integration". |
| **Relationships** | The people-and-companies destination. Never "Contacts" as a nav label. |

## 15. Drift from the current code

`src/app/globals.css` as committed implements a narrower register. This table
is the migration checklist for the System-first build step; until it is empty,
reading the CSS will mislead you.

| Area | Code today | This system |
|---|---|---|
| Ground | Cool near-white `oklch(0.99 0.002 260)` | Warm bone `oklch(0.975 0.005 85)` |
| Accent | One Linear indigo, all three app tokens aliased to it | Three app accents (cyan / green / violet) |
| Type | Inter sans + serif page titles | Same; serif role now documented and bounded |
| Radii | `--radius: 0.375rem` with derived ladder | 3 / 4.5 / 6 / 9 lock |
| Shadow | One soft shadow token, unused by panels | Unchanged, now explicitly restricted to floating layers |
| Preview routes | `/apps/*` still mounted | Delete; canonical routes only |
| Registries | `navigation.ts` and `products.ts` both live, with conflicting labels | One registry; `products.ts` retires |
| Nav shape | `nav: "rail" \| "bar"` declared in `navigation.ts` | Unchanged; this is the spec, not drift |

## 16. Open items

- **Icon family.** `lucide-react` is installed. The intended family is
  Phosphor or Tabler. One family per tree, one global `strokeWidth`, never a
  hand-rolled icon path. Migration not started.
- **Motion dependency.** `motion` is not installed. Install it when the reward
  animations land, not before.
- **Stone art.** Reward surfaces only. Not yet designed.
