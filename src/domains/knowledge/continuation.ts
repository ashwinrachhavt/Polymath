/*
 * The next step for an open artifact, derived from its status alone. Used by
 * the notebook's draft review: a suggestion, never a task the person picked.
 */
export function artifactNextStep(status: string): string | null {
  switch (status) {
    case "draft":
      return "Review it: keep the draft or discard it.";
    case "reviewed":
      return "Decide what this output becomes next.";
    default:
      return null;
  }
}
