import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { databaseUrl, gatewayUrl, isIsolatedDatabase, loadE2eEnvironment, openDatabase } from "../e2e/helpers/database";

const { end } = vi.hoisted(() => ({ end: vi.fn<() => Promise<void>>() }));
vi.mock("postgres", () => ({ default: vi.fn(() => ({ end })) }));

let directory: string;
let environment: NodeJS.ProcessEnv;
beforeEach(() => {
  environment = { ...process.env };
  delete process.env.DATABASE_URL;
  delete process.env.EVE_GATEWAY_SECRET;
  directory = mkdtempSync(join(tmpdir(), "e2e-environment-"));
  vi.clearAllMocks();
  end.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
  rmSync(directory, { recursive: true, force: true });
});

describe("e2e environment", () => {
  it("preserves process values, loads local before env, and fills absent keys", () => {
    writeFileSync(join(directory, ".env.local"), "DATABASE_URL=postgres://local/db\nEVE_GATEWAY_SECRET=local-secret\n");
    writeFileSync(join(directory, ".env"), "DATABASE_URL=postgres://env/db\nEVE_GATEWAY_SECRET=env-secret\n");
    process.env.DATABASE_URL = "postgres://process/db";
    expect(databaseUrl(directory)).toBe("postgres://process/db");
    expect(process.env.EVE_GATEWAY_SECRET).toBe("local-secret");
    delete process.env.DATABASE_URL;
    expect(databaseUrl(directory)).toBe("postgres://local/db");
    expect(databaseUrl(directory)).toBe("postgres://local/db");
  });

  it("falls back to .env and accepts missing optional files", () => {
    expect(databaseUrl(directory)).toBeNull();
    writeFileSync(join(directory, ".env"), "DATABASE_URL=postgres://env/db\n");
    expect(databaseUrl(directory)).toBe("postgres://env/db");
  });

  it("does not overwrite an explicitly empty process value", () => {
    process.env.DATABASE_URL = "";
    writeFileSync(join(directory, ".env"), "DATABASE_URL=postgres://env/db\n");
    expect(databaseUrl(directory)).toBeNull();
    expect(process.env.DATABASE_URL).toBe("");
  });

  it("surfaces unreadable env files instead of silently skipping configuration", () => {
    mkdirSync(join(directory, ".env.local"));
    expect(() => loadE2eEnvironment(directory)).toThrow();
  });
});

describe("per-operation connections", () => {
  it("returns null without invoking the driver when configuration is missing", async () => {
    await using database = openDatabase(databaseUrl(directory));
    expect(database).toBeNull();
    expect(postgres).not.toHaveBeenCalled();
  });

  it("owns a separate max-one connection for each operation and closes on return", async () => {
    async function operation(): Promise<void> {
      await using first = openDatabase("postgres://fixture/test");
      await using second = openDatabase("postgres://fixture/test");
      expect(first?.sql).not.toBe(second?.sql);
      expect(end).not.toHaveBeenCalled();
    }
    await operation();
    expect(postgres).toHaveBeenCalledTimes(2);
    expect(postgres).toHaveBeenCalledWith("postgres://fixture/test", { max: 1 });
    expect(end).toHaveBeenCalledTimes(2);
  });

  it("closes when an assertion, seed, skip, or row cleanup throws", async () => {
    const failure = new Error("operation failed");
    async function operation(): Promise<void> {
      await using database = openDatabase("postgres://fixture/test");
      expect(database).not.toBeNull();
      throw failure;
    }
    await expect(operation()).rejects.toBe(failure);
    expect(end).toHaveBeenCalledOnce();
  });

  it("surfaces connection close failures", async () => {
    const failure = new Error("close failed");
    end.mockRejectedValueOnce(failure);
    async function operation(): Promise<void> {
      await using database = openDatabase("postgres://fixture/test");
      expect(database).not.toBeNull();
    }
    await expect(operation()).rejects.toBe(failure);
  });
});

describe("fixture boundaries", () => {
  it("uses the configured gateway origin and port, not a fixed localhost", () => {
    expect(gatewayUrl("http://127.0.0.1:4317/nested/").href).toBe("http://127.0.0.1:4317/api/mcp");
    expect(gatewayUrl("https://preview.example.invalid/").href).toBe("https://preview.example.invalid/api/mcp");
    expect(() => gatewayUrl(undefined)).toThrow("Playwright baseURL");
    expect(() => gatewayUrl("invalid")).toThrow();
  });

  it.each(["axiom_e2e", "test_db", "scratch", "E2E_fixture"])("permits shutdown only for isolated database %s", (name) => {
    expect(isIsolatedDatabase(`postgres://fixture/${name}`)).toBe(true);
  });

  it.each(["postgres://fixture/polymath", "postgres://fixture/production", "not a URL", "postgres://fixture/"])("refuses shutdown for %s", (url) => {
    expect(isIsolatedDatabase(url)).toBe(false);
  });
});
