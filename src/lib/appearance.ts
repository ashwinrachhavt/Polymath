/*
 * Appearance choices beyond light/dark: the page colour (paper) and the accent
 * that marks the primary action and selection. They are applied as
 * <html data-paper data-accent> (see app/appearance.css) and remembered in
 * this browser. Light/dark/system stays with next-themes and the account
 * preference row.
 */

export const PAPERS = [
  { value: "white", label: "White", swatch: "oklch(100% 0 0)" },
  { value: "warm", label: "Warm", swatch: "oklch(96% 0.011 85)" },
] as const;

export const ACCENTS = [
  { value: "graphite", label: "Graphite", swatch: "oklch(26% 0.008 260)" },
  { value: "blue", label: "Blue", swatch: "oklch(54% 0.17 255)" },
  { value: "green", label: "Green", swatch: "oklch(50% 0.12 155)" },
  { value: "violet", label: "Violet", swatch: "oklch(52% 0.17 295)" },
  { value: "rose", label: "Rose", swatch: "oklch(56% 0.17 10)" },
] as const;

type Paper = (typeof PAPERS)[number]["value"];
type Accent = (typeof ACCENTS)[number]["value"];
export type AppearanceChoice = { paper: Paper; accent: Accent };

export const APPEARANCE_STORAGE_KEY = "polymath.appearance";
export const DEFAULT_APPEARANCE: AppearanceChoice = { paper: "white", accent: "graphite" };

const isPaper = (value: unknown): value is Paper => PAPERS.some((p) => p.value === value);
const isAccent = (value: unknown): value is Accent => ACCENTS.some((a) => a.value === value);

export function readAppearance(): AppearanceChoice {
  try {
    const raw = JSON.parse(
      window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "null",
    ) as Partial<AppearanceChoice> | null;
    return {
      paper: isPaper(raw?.paper) ? raw.paper : DEFAULT_APPEARANCE.paper,
      accent: isAccent(raw?.accent) ? raw.accent : DEFAULT_APPEARANCE.accent,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Apply to the document now and remember it in this browser. */
export function saveAppearance(choice: AppearanceChoice): void {
  const root = document.documentElement;
  root.dataset.paper = choice.paper;
  root.dataset.accent = choice.accent;
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Private mode or blocked storage: the choice still applies to this page.
  }
}

/*
 * Runs in <head> before first paint so a saved choice never flashes the
 * default. Plain ES5, no imports: it is inlined as a string. Unknown values
 * are ignored, so a stale or tampered entry falls back to the defaults.
 */
export const APPEARANCE_BOOT_SCRIPT = `(function(){try{var c=JSON.parse(localStorage.getItem(${JSON.stringify(
  APPEARANCE_STORAGE_KEY,
)})||"null")||{};var d=document.documentElement;if(${JSON.stringify(PAPERS.map((p) => p.value))}.indexOf(c.paper)>=0)d.dataset.paper=c.paper;if(${JSON.stringify(
  ACCENTS.map((a) => a.value),
)}.indexOf(c.accent)>=0)d.dataset.accent=c.accent;}catch(e){}})();`;
