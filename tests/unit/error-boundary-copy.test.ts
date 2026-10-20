import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/*
 * Error boundaries are client components whose whole contract is copy plus two
 * controls, so the assertions are on source text rather than on rendered
 * output. What matters: no boundary claims what an earlier write did, each
 * keeps a retry, and each shows the digest that ties a crash to the server log.
 */

const ROOT = path.resolve(__dirname, "../..");

const GLOBAL = "src/app/global-error.tsx";
const ALFRED = "src/app/(workspace)/apps/alfred/error.tsx";
const COMMAND_CENTER = "src/app/(workspace)/apps/command-center/error.tsx";

function source(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("global error boundary", () => {
  const file = () => source(GLOBAL);

  it("is a client component that supplies its own document", () => {
    const text = file();
    expect(text).toContain('"use client"');
    expect(text).toMatch(/<html[\s>]/);
    expect(text).toMatch(/<body[\s>]/);
  });

  it("does not rely on the app stylesheet reaching the root", () => {
    const text = file();
    // Inline styles only: no imports of the design system or global CSS.
    expect(text).not.toContain("globals.css");
    expect(text).not.toContain("@/components/ui/button");
    expect(text).toContain("style={{");
  });

  it("offers both reset and reload", () => {
    const text = file();
    expect(text).toContain("reset");
    expect(text).toContain("window.location.reload()");
  });

  it("shows the digest when present", () => {
    expect(file()).toContain("error.digest");
  });

  it("never assures the reader that nothing was saved", () => {
    const text = file();
    expect(text).not.toMatch(/have not (been )?(performed|saved|created)/i);
    expect(text).not.toMatch(/nothing (was|has been) (saved|created)/i);
    expect(text).toContain("may still have gone through");
  });
});

describe("app-level error boundaries", () => {
  const files = [ALFRED, COMMAND_CENTER];

  it("drop the outcome guarantees a render crash cannot make", () => {
    const alfred = source(ALFRED);
    const commandCenter = source(COMMAND_CENTER);
    expect(alfred).not.toContain("have not performed any work");
    expect(commandCenter).not.toContain("Retry without creating a new external action");
  });

  it("tell the reader the outcome is ambiguous and to check first", () => {
    for (const rel of files) {
      const text = source(rel);
      expect(text, rel).toMatch(/may still have gone through/);
      expect(text, rel).toMatch(/check/i);
    }
  });

  it("keep the alert role and a retry control", () => {
    for (const rel of files) {
      const text = source(rel);
      expect(text, rel).toContain('role="alert"');
      expect(text, rel).toMatch(/onClick=\{reset\}/);
    }
  });

  it("show the digest when present", () => {
    for (const rel of files) {
      expect(source(rel), rel).toContain("error.digest");
    }
  });
});

describe("boundary copy style", () => {
  const files = [GLOBAL, ALFRED, COMMAND_CENTER];

  it("uses no em dash in user-visible strings", () => {
    for (const rel of files) {
      expect(source(rel), rel).not.toContain("—");
    }
  });
});
