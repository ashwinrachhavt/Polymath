/*
 * Deterministic redaction for everything extracted from an agent transcript
 * into a SessionSummary. Both agents write plaintext locally, and anything
 * that passed through a tool — file contents, command output, pasted text —
 * can carry credentials (art_GNwwKckZ §4). Upstream redaction covers only the
 * agents' own upload paths, so Polymath applies its own scrub before
 * persisting, displaying, or exporting a summary. Raw transcript bytes are
 * stored as-received and are never run through this module or any renderer.
 *
 * Replacement is the literal `[redacted]` — deterministic across runs, so the
 * same transcript always produces the same stored summary and the same
 * content-hash dedupe behaviour.
 */

const REPLACEMENT = "[redacted]";

type Rule = { name: string; pattern: RegExp };

/** Ordered: overlapping shapes are matched by the most specific rule first. */
const RULES: Rule[] = [
  {
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // `API_KEY=…` / `PASSWORD: …` assignment shapes, including .env dumps and
  // printed config. Runs before the token-shape rules so a value like a GitHub
  // token is replaced once as a whole. The key name survives; only the value
  // is replaced. Six characters minimum: under-redacting is the costlier error.
  {
    name: "credential-assignment",
    pattern:
      /\b([A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|passwd|credential)[A-Za-z0-9_-]*)\b(\s*[:=]\s*)["']?([^\s"']{6,})["']?/gi,
  },
  // JWT: three base64url segments. Must precede bearer, which would otherwise
  // eat only the first segment.
  {
    name: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  },
  { name: "openai-key", pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g },
  { name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "github-pat", pattern: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: "slack-token", pattern: /xox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{30,}/g },
  // Fernet-shaped ciphertext — Codex inter-agent payloads use it, and leaked
  // Fernet tokens are live credentials by construction.
  { name: "fernet-token", pattern: /gAAAA[A-Za-z0-9_-]{20,}/g },
  { name: "bearer-header", pattern: /\b(?:bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi },
];

export const REDACTED = REPLACEMENT;

/**
 * Replace credential-shaped substrings with `[redacted]`. Pure and
 * order-stable: rules run in declaration order, each over the result of the
 * last, so a value matched by two rules is still replaced exactly once.
 */
export function redactString(input: string): string {
  let result = input;
  for (const rule of RULES) {
    result = result.replace(rule.pattern, (match, ...rest) => {
      // The assignment rule keeps the key name visible; every other rule
      // replaces the whole match.
      if (rule.name !== "credential-assignment") return REPLACEMENT;
      const prefix = rest.slice(0, 2).filter((part) => typeof part === "string");
      return `${prefix.join("")}${REPLACEMENT}`;
    });
  }
  return result;
}

/** Long text fields are trimmed before storage so one dumped file cannot bloat a summary row. */
export function redactExcerpt(input: string, maxLength = 2000): string {
  const cleaned = redactString(input).trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}
