/*
 * The relationship-status vocabulary as a dependency-free leaf: client forms
 * need the labels without pulling the db-backed query module (and its
 * postgres driver) into the browser bundle. The literals mirror the
 * `relationship_status` pgEnum; queries.ts re-exports them for server code.
 */
export const RELATIONSHIP_STATUSES = ["unknown", "cold", "warm", "active", "dormant"] as const;
export type RelationshipStatus = (typeof RELATIONSHIP_STATUSES)[number];

export const RELATIONSHIP_STATUS_LABELS: Record<RelationshipStatus, string> = {
  unknown: "Unknown",
  cold: "Cold",
  warm: "Warm",
  active: "Active",
  dormant: "Dormant",
};
