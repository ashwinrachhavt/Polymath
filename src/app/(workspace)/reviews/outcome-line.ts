import type { EffectOutcome } from "@/domains/actions/executor";

/*
 * One line, from the executor's own outcome. The copy is fixed here rather
 * than assembled from provider text: "unknown" exists to say the system does
 * not know, and no wording may invite a second send. A failed effect is never
 * presented as something to repeat; that is a new approval, not a re-run.
 *
 * The same line renders from the decide response and from the persisted
 * attempt on reload - async effects settle after the reviewer leaves, and the
 * card must tell that truth when they return.
 */

/* Stored error codes are for machines; the card speaks for a person. */
const CANVA_FAILURE_COPY: Record<string, string> = {
  canva_import_failed: "Canva reported the import failed.",
};

export function outcomeLine(capability: string, outcome: EffectOutcome): string {
  // Import wording: an async Canva job is not a send, and "sent" would lie
  // about what happened.
  const canva = capability === "canva.design.import";
  switch (outcome.status) {
    case "sent":
      return canva ? "Imported to Canva." : "Sent.";
    case "unknown":
      // The two honest UNKNOWN phases stay distinct for a person: a job
      // Canva accepted (terminal answer pending) is not a lost creation.
      if (canva) {
        return outcome.note === "import_started"
          ? "Import job created; Polymath is waiting for Canva's terminal result."
          : "Outcome unconfirmed; Polymath checks with Canva before anything runs again.";
      }
      return "Checking whether this was sent.";
    case "failed":
      if (canva) return `Not imported. ${CANVA_FAILURE_COPY[outcome.reason] ?? outcome.reason}`;
      return `Not sent. ${outcome.reason}`;
  }
}
