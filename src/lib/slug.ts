/*
 * One slugify, two consumers: the create-workspace form's live address
 * pre-fill and createWorkspace's server-side normalization. Sharing it is the
 * point — what the user previewed while typing is exactly what the server
 * derives, so the auto path never surprises.
 */

/** Lowercase letters, digits, and single hyphens, capped at 48 chars. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // Café -> Cafe, so accents do not become ""
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}
