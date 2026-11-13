import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

/*
 * Value: protects=the phone shell's contract: pinch-zoom stays on while inputs stay at 16px so iOS
 * does not zoom on focus, the page fills the screen (viewport-fit=cover), and "Add to Home Screen"
 * opens a standalone app with real icons; fails_when=someone "fixes" zoom with maximum-scale or
 * user-scalable=no, the 16px phone rule is dropped, viewport-fit goes missing (safe-area insets
 * then read 0), the manifest loses display: standalone, or an icon it names does not exist;
 * why_new=the phone shell is new; seam=the source of layout.tsx and globals.css plus the manifest
 * function; no_claim=how it renders on a device
 */

const layout = readFileSync("src/app/layout.tsx", "utf8");
const css = readFileSync("src/app/globals.css", "utf8");

describe("phone viewport", () => {
  it("fills the screen and keeps pinch-zoom", () => {
    expect(layout).toMatch(/viewportFit:\s*"cover"/);
    expect(layout).not.toMatch(/maximumScale|userScalable|maximum-scale|user-scalable/);
  });

  it("keeps every phone field at 16px so iOS does not zoom on focus", () => {
    const block = css.slice(css.indexOf("@media (max-width: 767px) {\n  input:not("));
    expect(block.length).toBeGreaterThan(0);
    expect(block).toMatch(/textarea,\s*select,\s*\[contenteditable\][^{]*\{\s*font-size:\s*16px;/);
  });

  it("sizes the conversation shell by the visible height above the keyboard", () => {
    expect(css).toMatch(/\.shell-conversation\s*\{[^}]*height:\s*var\(--vvh,\s*100dvh\)/);
  });
});

describe("web app manifest", () => {
  const m = manifest();

  it("opens standalone from the root", () => {
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    expect(m.name).toBe("Polymath");
  });

  it("names icons that exist, including a maskable one", () => {
    const icons = m.icons ?? [];
    expect(icons.some((icon) => icon.purpose === "maskable")).toBe(true);
    for (const icon of icons) expect(existsSync(`public${icon.src}`), icon.src).toBe(true);
    expect(existsSync("public/icons/apple-touch-icon.png")).toBe(true);
  });
});
