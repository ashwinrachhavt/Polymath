import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localDiskEnabled, objectStoreMode } from "@/integrations/object-store/mode";
import { capabilityStatus } from "@/lib/capability-config";

describe("objectStoreMode", () => {
  it("uses local disk in development without any configuration", () => {
    expect(objectStoreMode({ NODE_ENV: "development" })).toBe("local");
  });

  it("fails closed in production with nothing configured", () => {
    expect(objectStoreMode({ NODE_ENV: "production" })).toBe("unconfigured");
  });

  it("needs both the opt-in and a directory before production writes to disk", () => {
    expect(objectStoreMode({ NODE_ENV: "production", POLYMATH_OBJECT_STORE: "local-disk" })).toBe("unconfigured");
    expect(objectStoreMode({ NODE_ENV: "production", AXIOM_LOCAL_BLOB_DIR: "/data/blobs" })).toBe("unconfigured");
    expect(
      objectStoreMode({
        NODE_ENV: "production",
        POLYMATH_OBJECT_STORE: "local-disk",
        AXIOM_LOCAL_BLOB_DIR: "/data/blobs",
      }),
    ).toBe("local");
  });

  it("keeps Vercel Blob first whenever it is configured", () => {
    expect(
      objectStoreMode({
        NODE_ENV: "production",
        BLOB_READ_WRITE_TOKEN: "token",
        POLYMATH_OBJECT_STORE: "local-disk",
        AXIOM_LOCAL_BLOB_DIR: "/data/blobs",
      }),
    ).toBe("vercel-blob");
  });

  it("treats a blank token as unset", () => {
    expect(objectStoreMode({ NODE_ENV: "production", BLOB_READ_WRITE_TOKEN: "  " })).toBe("unconfigured");
    expect(
      localDiskEnabled({ NODE_ENV: "production", POLYMATH_OBJECT_STORE: "local-disk", AXIOM_LOCAL_BLOB_DIR: " " }),
    ).toBe(false);
  });

  it("reports the opted-in disk store as ready in the settings panel", () => {
    const storage = capabilityStatus({
      NODE_ENV: "production",
      POLYMATH_OBJECT_STORE: "local-disk",
      AXIOM_LOCAL_BLOB_DIR: "/data/blobs",
    }).find((c) => c.id === "private-file-storage");
    expect(storage?.configured).toBe(true);
  });
});

describe("local disk in a self-hosted production", () => {
  let dir: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function store(env: Record<string, string>) {
    dir = await mkdtemp(path.join(tmpdir(), "polymath-blobs-"));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("BLOB_STORE_ID", "");
    vi.stubEnv("AXIOM_LOCAL_BLOB_DIR", dir);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.resetModules();
    return import("@/integrations/object-store/object-store");
  }

  it("writes under the configured directory and reads the bytes back", async () => {
    const { putBlob, readBlob } = await store({ POLYMATH_OBJECT_STORE: "local-disk" });
    const bytes = new TextEncoder().encode("hello");
    const { storageKey } = await putBlob({
      bytes,
      filename: "note.txt",
      contentType: "text/plain",
      workspaceId: "ws-1",
    });
    expect(storageKey.startsWith("local:workspaces/ws-1/")).toBe(true);
    expect(await readdir(path.join(dir!, "workspaces", "ws-1"))).toHaveLength(1);
    expect(new TextDecoder().decode(await readBlob(storageKey))).toBe("hello");
  });

  it("refuses uploads and local reads without the opt-in", async () => {
    const { putBlob, readBlob, ObjectStoreUnconfiguredError } = await store({ POLYMATH_OBJECT_STORE: "" });
    await expect(
      putBlob({ bytes: new Uint8Array([1]), filename: "a", contentType: "text/plain", workspaceId: "ws-1" }),
    ).rejects.toBeInstanceOf(ObjectStoreUnconfiguredError);
    await expect(readBlob("local:workspaces/ws-1/x/a")).rejects.toThrow(/not readable/);
  });
});
