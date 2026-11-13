/*
 * Which object store this deployment writes to. Pure (no fs, no SDK), so the
 * settings panel's capability check and the store itself share one rule.
 *
 *   Vercel Blob   BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID is set. Always wins.
 *   local disk    development, or production that opted in explicitly with
 *                 POLYMATH_OBJECT_STORE=local-disk and AXIOM_LOCAL_BLOB_DIR
 *                 (a self-hosted server with a persistent volume there).
 *   unconfigured  production with neither: uploads fail closed.
 *
 * Production never falls back to disk silently. A container's own filesystem
 * is gone on the next deploy, so local disk in production needs both the
 * opt-in and a directory the operator put on a volume.
 */

type Env = Record<string, string | undefined>;

export function localDiskEnabled(env: Env = process.env): boolean {
  if (env.NODE_ENV !== "production") return true;
  return env.POLYMATH_OBJECT_STORE?.trim() === "local-disk" && Boolean(env.AXIOM_LOCAL_BLOB_DIR?.trim());
}

export function objectStoreMode(env: Env = process.env): "vercel-blob" | "local" | "unconfigured" {
  if (env.BLOB_READ_WRITE_TOKEN?.trim() || env.BLOB_STORE_ID?.trim()) return "vercel-blob";
  return localDiskEnabled(env) ? "local" : "unconfigured";
}
