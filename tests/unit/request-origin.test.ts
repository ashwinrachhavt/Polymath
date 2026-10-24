import { describe, expect, it } from "vitest";
import { resolveRequestOrigin } from "@/domains/integrations/origin";

/*
 * The OAuth callback carries the state token, so its origin must be one this
 * deployment owns. APP_ORIGIN is the operator's word; a request's Host /
 * X-Forwarded-Host is client-supplied and only trusted when the platform
 * confirms it as this deployment's own. Anything else is refused: guessing
 * would hand an attacker the OAuth return on their domain.
 */
describe("resolveRequestOrigin", () => {
  it("APP_ORIGIN wins over every header", () => {
    const r = resolveRequestOrigin({
      host: "evil.example",
      proto: "https",
      env: { APP_ORIGIN: "https://axiom.example.com" },
    });
    expect(r).toEqual({ ok: true, origin: "https://axiom.example.com" });
  });

  it("a Vercel deployment host is trusted over https", () => {
    for (const key of ["VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_BRANCH_URL", "VERCEL_URL"] as const) {
      const r = resolveRequestOrigin({
        host: "axiom-abc123-owner.vercel.app",
        proto: "https",
        env: { [key]: "axiom-abc123-owner.vercel.app" },
      });
      expect(r, key).toEqual({ ok: true, origin: "https://axiom-abc123-owner.vercel.app" });
    }
  });

  it("a host the platform does not claim is refused, not guessed", () => {
    const r = resolveRequestOrigin({
      host: "attacker.example",
      proto: "https",
      env: { VERCEL_URL: "axiom-abc123-owner.vercel.app" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("APP_ORIGIN");
  });

  it("host matching is case-insensitive", () => {
    const r = resolveRequestOrigin({
      host: "AXIOM-ABC123.vercel.app",
      proto: "https",
      env: { VERCEL_URL: "axiom-abc123.vercel.app" },
    });
    expect(r.ok).toBe(true);
  });

  it("localhost and 127.0.0.1 are allowed over http for dev", () => {
    expect(resolveRequestOrigin({ host: "localhost:3000", proto: "http", env: {} })).toEqual({
      ok: true,
      origin: "http://localhost:3000",
    });
    expect(resolveRequestOrigin({ host: "127.0.0.1:3000", proto: "http", env: {} })).toEqual({
      ok: true,
      origin: "http://127.0.0.1:3000",
    });
  });

  it("no host and no APP_ORIGIN falls back to the dev default", () => {
    expect(resolveRequestOrigin({ host: null, proto: null, env: {} })).toEqual({
      ok: true,
      origin: "http://localhost:3000",
    });
  });
});
