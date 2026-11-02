/** The admission table: per receiving scope, what each kind of sender's message may become. Ported from the prototype's `src/admission.ts`. */
import type { AdmissionCell } from "../model";

/** What a receiving scope's cell decides a message is: an explicit request, an inferred candidate, or nothing. */
export type Admission = "explicit" | "inferred" | "ignore";

/** The choices each cell may hold; an unaddressed message can never be explicit. */
export const ADMISSION_OPTIONS = {
  listedUnaddressed: ["inferred", "ignore"],
  unlistedAddressed: ["explicit", "inferred", "ignore"],
  unlistedUnaddressed: ["inferred", "ignore"],
} as const satisfies Record<AdmissionCell, readonly Admission[]>;

/** One receiving scope's row: the cells it overrides; absent cells keep the defaults. */
export type AdmissionRow = { [C in AdmissionCell]?: (typeof ADMISSION_OPTIONS)[C][number] };

/**
 * Default admission rules (matching pre-table behavior): unaddressed messages from listed senders are
 * inferred candidates; unlisted senders are ignored, addressed or not.
 */
export const ADMISSION_DEFAULTS: Readonly<Record<AdmissionCell, Admission>> = {
  listedUnaddressed: "inferred",
  unlistedAddressed: "ignore",
  unlistedUnaddressed: "ignore",
};
