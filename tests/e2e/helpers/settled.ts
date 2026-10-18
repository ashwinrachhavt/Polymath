import { expect, type Page } from "@playwright/test";

/*
 * Axe composites the background it samples through whatever opacity and
 * transition state an element is in. Three separate flake classes came from
 * sampling inside a transition window: the topbar buttons sit at
 * disabled:opacity-50 until hydration and the `disabled` attribute flips
 * before the opacity transition (transition-all) finishes, so toBeEnabled
 * resolves on a still-fading button. Every axe run goes through here.
 */
export async function waitSettled(page: Page, landmarks: { capture?: boolean; heading?: string } = {}) {
  // Hydration: the app launcher's trigger enables when the page has hydrated
  // (it was the Capture button before the three-app shell landed).
  if (landmarks.capture !== false) await expect(page.getByRole("button", { name: "Open apps" })).toBeEnabled();
  // Async client-only surfaces (the Notebook rich editor toolbar mounts
  // through immediatelyRender: false) hold disabled buttons a frame longer.
  if (landmarks.heading) await expect(page.getByRole("button", { name: landmarks.heading, exact: true })).toBeEnabled();
  // No animation anywhere is mid-flight: every transitioning element has
  // reached its computed opacity. Permanently disabled buttons (the Ask-AI
  // controls) hold disabled:opacity-50 forever, so they are excluded; the
  // hydration fade only affects buttons that end enabled. Reduced motion
  // collapses transitions, so the check is for the settle path only.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].every((element) => {
      if ((element as HTMLButtonElement).disabled) return true;
      const opacity = getComputedStyle(element).opacity;
      return opacity !== "" && Number(opacity) > 0.99;
    }),
  );
}
