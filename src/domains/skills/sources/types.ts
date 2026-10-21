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
  | "invalid_metadata";

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
