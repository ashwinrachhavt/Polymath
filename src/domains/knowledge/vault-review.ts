import type { LibraryStateFilter } from "./library";
import type { DocumentStatusTone } from "./status";

/*
 * What the vault says about a document's review state.
 *
 * status.ts is the review inbox's vocabulary: it names the pipeline's own
 * stages (proposed, not proposed, fields not read). That is the right detail
 * for the workbench and the wrong thing for a file browser, where the only
 * useful signal is "can I act on this row?". This mapping keeps the same
 * source of truth but answers that one question in the owner's words.
 *
 * A null result means there is nothing to say: the document is filed. The
 * vault leaves that cell quiet instead of printing a green badge on every row.
 */

/** The library's state key, reused so a new state is a type error here, not silence. */
export type VaultStateKey = LibraryStateFilter;
export type VaultTone = DocumentStatusTone;

export type VaultReview = {
  label: string;
  tone: VaultTone;
  /** One sentence for the tooltip and the preview header. */
  detail: string;
  /** True when the row is an exception the owner can act on. */
  needsReview: boolean;
};

export function vaultReview(
  key: VaultStateKey,
  undecidedProposals = 0,
): VaultReview | null {
  switch (key) {
    case "added":
      return {
        label: "Not read yet",
        tone: "neutral",
        detail: "Nothing has read this document yet. Open it to start a read.",
        needsReview: false,
      };
    case "reading":
      return {
        label: "Reading…",
        tone: "progress",
        detail: "A read is queued or running.",
        needsReview: false,
      };
    case "could_not_read":
      return {
        label: "Couldn't read",
        tone: "error",
        detail: "The reader could not read this file. Open it to retry.",
        needsReview: true,
      };
    case "fields_not_read":
      return {
        label: "Needs review",
        tone: "error",
        detail: "The text was read, but proposing its fields failed. Open it to retry.",
        needsReview: true,
      };
    case "fields_not_proposed":
      return {
        label: "Needs review",
        tone: "attention",
        detail: "The text was read, but no fields have been proposed from it yet.",
        needsReview: true,
      };
    case "needs_check":
      return {
        label: undecidedProposals > 0 ? `${undecidedProposals} to review` : "Needs review",
        tone: "attention",
        detail:
          undecidedProposals > 0
            ? `${undecidedProposals} field proposal${undecidedProposals === 1 ? " is" : "s are"} waiting for your decision.`
            : "Field proposals are waiting for your decision.",
        needsReview: true,
      };
    case "filed":
      return null;
    default:
      return null;
  }
}
