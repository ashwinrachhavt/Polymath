import type { InspectedSkill } from "../manifest";

/*
 * The contract between whatever reads a source (a pasted command, a GitHub
 * URL, a local folder) and the inspection entry point. Adapters return this
 * shape so the install action never needs to know which one produced it.
 */
export type SourceRequest =
  | { kind: "github"; owner: string; repo: string; ref?: string; path?: string }
  | { kind: "local"; root: string; path?: string };

export type InspectResult =
  | {
      ok: true;
      sourceKind: "github" | "local";
      sourceRef: string;
      revision: string;
      skills: InspectedSkill[];
      warnings: string[];
    }
  | { ok: false; code: InspectFailureCode; message: string };

export type InspectFailureCode =
  | "unsupported_input"
  | "unsafe_command"
  | "not_found"
  | "private_repo"
  | "rate_limited"
  | "timeout"
  | "too_large"
  | "no_skill_found"
  | "unsafe_path"
  | "invalid_metadata"
  /** The upstream answered, but with a failure this adapter does not model. */
  | "unavailable"
  /** The folder exists but the operating system refused to list or read it. */
  | "unreadable"
  /**
   * An adapter's own bug, not anything the person did. It gets its own code so
   * "not_found" never stands in for "we crashed", which would send someone
   * checking a path that is fine.
   */
  | "internal";

/*
 * A rejection the caller should show as one named failure. Adapters let this
 * escape `extractPackages` and map it to `InspectResult`; throwing here (rather
 * than returning an error union from every helper) keeps the happy path flat
 * and makes it impossible to continue inspecting after a safety failure.
 */
export class InspectError extends Error {
  constructor(
    readonly code: InspectFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "InspectError";
  }
}

/**
 * The single exit from an adapter's `try`. An `InspectError` already carries the
 * code and sentence the person should see; anything else is a bug in the
 * adapter, so it reports `internal` rather than borrowing a code that describes
 * the person's input.
 */
export function failureResult(error: unknown, internalMessage: string): InspectResult {
  if (error instanceof InspectError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return { ok: false, code: "internal", message: internalMessage };
}
