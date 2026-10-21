/*
 * The readiness words are fixed by the ticket. A skill in this slice either
 * carries no declared requirement (Ready) or has been switched off (Disabled);
 * `Needs connection`, `Needs account selection`, `Unsupported requirement`, and
 * `Restart required` are in the union so a later slice can report them without
 * inventing a synonym, but nothing here produces them yet because no
 * requirement is stored on a skill.
 */
export type SkillReadiness =
  | "Ready"
  | "Needs connection"
  | "Needs account selection"
  | "Unsupported requirement"
  | "Disabled"
  | "Restart required";

export function skillReadiness(skill: { enabled: boolean }): SkillReadiness {
  return skill.enabled ? "Ready" : "Disabled";
}

/** The two values the page can filter on, one per readiness this slice produces. */
export const READINESS_FILTERS = ["ready", "disabled"] as const;
