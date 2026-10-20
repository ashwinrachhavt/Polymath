import type { AuthRole } from "./resolve";

/*
 * ASH-121 AC03: the approved capability catalog. Custom roles (a later slice)
 * compose ONLY from these entries - a role definition that names anything
 * else is invalid, so custom roles can never invent permissions. Nothing in
 * the request path reads this module yet: the four fixed roles still rule
 * through the RANK comparison in lib/auth/guards.ts, and ADR 0002 stays the
 * authority. This is the catalog those custom roles will draw from, plus an
 * honest documentary projection of what the fixed roles cover today.
 *
 * The catalog is versioned: a stored role revision pins the catalog version
 * it was defined against, so tightening the catalog later is a visible
 * migration, not a silent change in what a role means.
 *
 * v2 (ADR 0006 Q2, owner-approved): adds task.read and knowledge.read so the
 * agent tool gateway can authorize reads at honest granularity instead of
 * laundering them through document.read. Additive: no v1 entry changed.
 */

export const CAPABILITY_CATALOG_VERSION = 2 as const;

export const CAPABILITIES = [
  // Person records (contacts, companies, party data).
  "person.read",
  "person.create",
  "person.update",
  "person.delete",
  "person.export",
  // Documents and knowledge.
  "document.read",
  "document.create",
  "document.update",
  "document.delete",
  "document.export",
  // Tasks and the knowledge base, read at their own granularity (v2).
  "task.read",
  "knowledge.read",
  // Member administration.
  "member.read",
  "member.invite",
  "member.suspend",
  "member.remove",
  // Role definition and assignment.
  "role.read",
  "role.define",
  "role.assign",
  // Integrations: connecting an account, using it, managing its grants are separate.
  "integration.connect",
  "integration.use",
  "integration.manage",
  // Agents: running is separate from changing configuration or policy.
  "agent.run",
  "agent.configure",
  // Supervised actions: preparing, approving and executing are separate on purpose.
  "action.prepare",
  "action.approve",
  "action.execute",
  // Billing administration without business-content access.
  "billing.read",
  "billing.manage",
  // Audit inspection.
  "audit.read",
  // Ownership transfer stands alone; even an owner delegates it only to a successor.
  "ownership.transfer",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const KNOWN = new Set<string>(CAPABILITIES);

/**
 * A proposed role definition (fixed or custom) is a set of catalog entries.
 * Validation is deterministic: unknown capabilities are rejected by name,
 * duplicates collapse, and an empty role is a caller error - a role that
 * grants nothing is a mistake, not a statement.
 */
export function validateRoleCapabilities(input: string[]): { ok: true; capabilities: Capability[] } | { ok: false; invalid: string[] } {
  const unique = [...new Set(input.map((c) => c.trim()))];
  const invalid = unique.filter((c) => !KNOWN.has(c));
  if (invalid.length) return { ok: false, invalid };
  if (!unique.length) return { ok: false, invalid: ["(empty role)"] };
  return { ok: true, capabilities: unique as Capability[] };
}

const READ_ONLY: Capability[] = ["person.read", "document.read", "task.read", "knowledge.read", "member.read", "role.read", "integration.use", "audit.read"];

const MEMBER_WORK: Capability[] = [
  ...READ_ONLY,
  "person.create",
  "person.update",
  "document.create",
  "document.update",
  "integration.connect",
  "agent.run",
  "action.prepare",
  "action.execute",
];

const ADMIN_DELEGATION: Capability[] = [
  ...MEMBER_WORK,
  "person.delete",
  "person.export",
  "document.delete",
  "document.export",
  "member.invite",
  "member.suspend",
  "integration.manage",
  "agent.configure",
  "action.approve",
  "billing.read",
];

/*
 * Documentary projection of the fixed roles onto the catalog. This records
 * what the RANK comparison in guards.ts already allows, in catalog terms, so
 * the role-change preview and the custom-role editor have a baseline. It is
 * NOT an enforcement source: guards.ts is. Where RANK is coarser than the
 * catalog (it has no export/prepare/approve distinction), the projection
 * picks the conservative reading and says so above each tier.
 */
export const FIXED_ROLE_CAPABILITIES: Record<AuthRole, readonly Capability[]> = {
  // Viewer reads and uses shared integrations; nothing mutates.
  viewer: READ_ONLY,
  // Member does everyday work; deletes and exports stay above this tier.
  member: MEMBER_WORK,
  // Admin delegates: membership, configuration, exports, approvals. Admin
  // cannot define roles, manage billing, or transfer ownership.
  admin: ADMIN_DELEGATION,
  // Owner holds everything, including role definition and ownership transfer.
  owner: [...ADMIN_DELEGATION, "member.remove", "role.define", "role.assign", "billing.manage", "ownership.transfer"],
};
