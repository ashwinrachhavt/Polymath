import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { destinations } from "@/lib/navigation";
import { products, productHref } from "@/lib/products";

/*
 * 2026-10-29 rename sweep audit (plan §9, §16.7): no internal href, redirect
 * destination or product link may still resolve to /alfred/* — those URLs
 * exist only as redirect SOURCES that forward to /polymath/*. A leftover
 * destination would loop or 404.
 *
 * Value: protects=no serialized internal link points at the retired /alfred
 * routes; fails_when=a destination, product href or next.config redirect
 * destination reintroduces /alfred/*.
 */

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

describe("rename sweep", () => {
  it("keeps every nav destination off /alfred/*", () => {
    for (const d of destinations) {
      expect(d.href).not.toMatch(/^\/(apps\/)?alfred(\/|$)/);
    }
  });

  it("keeps every product href off /apps/alfred/*", () => {
    for (const p of products) {
      expect(productHref(p)).not.toMatch(/^\/apps\/alfred(\/|$)/);
      for (const d of p.destinations) {
        expect(productHref(p, d.slug)).not.toMatch(/^\/apps\/alfred(\/|$)/);
      }
    }
    expect(products.map((p) => p.id)).toContain("polymath");
    expect(products.find((p) => p.id === "polymath")?.name).toBe("Polymath");
  });

  it("redirects legacy /alfred/* and /apps/alfred/* URLs and never redirects to them", () => {
    const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    expect(config).toContain('source: "/alfred/:path*"');
    expect(config).toContain('destination: "/polymath/:path*"');
    expect(config).toContain('source: "/apps/alfred/:path*"');
    expect(config).toContain('destination: "/apps/polymath/:path*"');
    // No redirect destination may point at a retired prefix (loop detection).
    const destinations = [...config.matchAll(/destination:\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const dest of destinations) {
      expect(dest).not.toMatch(/^\/(apps\/)?alfred(\/|$)/);
    }
  });

  it("has no /alfred route references left in app source", () => {
    const offenders: string[] = [];
    for (const file of walk(join(process.cwd(), "src"))) {
      const text = readFileSync(file, "utf8");
      if (/["'`]\/(apps\/)?alfred[/"'`?]/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
