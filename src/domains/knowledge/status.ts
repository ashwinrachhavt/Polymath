/*
 * The inbox's one status vocabulary (ASH-127). The database stores enum rows;
 * a human reads words. Every state maps to a label plus a tone, and the tone
 * is never the only signal — the label carries the meaning, the glyph and
 * color just point at it.
 */

export type DocumentStatusTone = "neutral" | "progress" | "attention" | "done" | "error";

export type DocumentStatus = { label: string; tone: DocumentStatusTone };

/**
 * Human state for one inbox row, from the latest extraction plus how many
 * field proposals are still undecided. No extraction row yet means the file is
 * uploaded but not read; a succeeded extraction with undecided proposals is
 * the one state that asks for the owner. Text that was read but whose fields
 * were never proposed (or whose proposal pass failed) is never "Filed".
 */
export function documentStatus(
  extraction: { status: string; error?: string | null; proposalStatus?: string | null } | null | undefined,
  undecidedProposals: number,
): DocumentStatus {
  if (!extraction) return { label: "Added", tone: "neutral" };
  switch (extraction.status) {
    case "pending":
    case "skipped":
      return { label: "Reading", tone: "progress" };
    case "failed":
      return { label: "Could not read", tone: "error" };
    case "succeeded":
      // Text alone is not filed: the proposal pass must have run too.
      if (extraction.proposalStatus === "failed") return { label: "Fields not read", tone: "error" };
      if (extraction.proposalStatus === "pending") return { label: "Reading", tone: "progress" };
      if (extraction.proposalStatus !== "succeeded") return { label: "Fields not proposed", tone: "attention" };
      return undecidedProposals > 0
        ? { label: "Needs your check", tone: "attention" }
        : { label: "Filed", tone: "done" };
    default:
      return { label: "Added", tone: "neutral" };
  }
}
