/*
 * Narrowing helpers for decoding agent-artifact JSONL. The upstream formats are
 * officially internal and version-changing (art_GNwwKckZ §1), so every field is
 * read as `unknown` and narrowed here — no `as` casts, and a shape that does not
 * match yields `undefined` rather than a crash. Callers count skips; nothing in
 * a parser throws on unexpected input.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** A field that arrives as a string or as a list of objects (Claude Code `message.content`). */
export function stringOrRecord(value: unknown): string | Record<string, unknown> | undefined {
  if (typeof value === "string") return value;
  return asRecord(value);
}

/** Pick the first field that narrows to a non-empty string. */
export function firstString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const found = asString(value[key]);
    if (found !== undefined && found.trim() !== "") return found;
  }
  return undefined;
}

/** Canonical JSON for stable dedupe keys; key order follows insertion, which is fine for same-writer data. */
export function stableKey(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`);
  return `{${entries.join(",")}}`;
}
