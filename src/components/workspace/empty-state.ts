import type { WorkspaceState } from "./types";

/*
 * The one and only initial workspace: empty. The product never boots with
 * fabricated records - no sample tasks, no fictional contacts, no demo
 * zettels (DESIGN.md § 10). A screen with nothing in it renders its designed
 * empty state and the action that fills it.
 *
 * Defaults that are real preferences (not content) are the exception: they
 * describe how the owner works, and every control for them stays editable.
 */
export const emptyWorkspaceState: WorkspaceState = {
  tasks: [],
  artifacts: [],
  artifactVersions: [],
  captures: [],
  contacts: [],
  companies: [],
  opportunities: [],
  reviews: [],
  projects: [],
  events: [],
  focus: null,
  rewards: [],
  preferences: { celebrations: true, reducedMotion: false, killSwitch: true, timezone: "America/Los_Angeles", weekStart: "Monday", scheduler: { workStartHour: 9, workEndHour: 18, weekdays: [1, 2, 3, 4, 5], suggestionsEnabled: true, eveningEnabled: false, eveningStartHour: 19, eveningTitle: "Vibe coding", topics: ["Research", "Engineering"] } },
  activity: [],
};
