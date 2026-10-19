import { CAPABILITIES, FIXED_ROLE_CAPABILITIES, validateRoleCapabilities, type Capability } from "./capabilities";
import type { AuthRole } from "./resolve";

/*
 * ASH-121 AC03: role-change preview. Before a role is assigned or revised,
 * the administrator sees exactly what changes: which capabilities are granted
 * or revoked and which product surfaces that touches. Pure functions over the
 * catalog - no database, no enforcement. The impacted-surface map is the
 * honest, reviewable part: it names what a capability family governs so a
 * change is read as consequences, not as a diff of strings.
 */

export type CapabilityDiff = { granted: Capability[]; revoked: Capability[] };

export function diffRoleCapabilities(from: readonly Capability[], to: readonly Capability[]): CapabilityDiff {
  const before = new Set(from);
  const after = new Set(to);
  return {
    granted: [...after].filter((c) => !before.has(c)),
    revoked: [...before].filter((c) => !after.has(c)),
  };
}

/** What each capability family governs, in product language. */
export const CAPABILITY_FAMILY_SURFACES: Record<string, string> = {
  person: "People and company records",
  document: "Documents and knowledge",
  member: "Workspace membership administration",
  role: "Role definitions and assignment",
  integration: "Connected integrations",
  agent: "Agent runs and configuration",
  action: "Supervised action preparation, approval and execution",
  billing: "Billing administration",
  audit: "Audit history",
  ownership: "Workspace ownership",
};

export function capabilityFamily(capability: Capability): string {
  return capability.split(".")[0];
}

export type RoleChangePreview = CapabilityDiff & {
  /** Surfaces losing all access vs gaining some, derived from the diff. */
  surfacesOpened: string[];
  surfacesClosed: string[];
};

/** Preview a change between a fixed role (or explicit set) and a proposed capability set. */
export function previewRoleChange(
  from: { role: AuthRole } | { capabilities: readonly Capability[] },
  toCapabilities: readonly string[],
): RoleChangePreview {
  const validated = validateRoleCapabilities([...toCapabilities]);
  if (!validated.ok) {
    throw new Error(`A role change can only name catalog capabilities; unknown: ${validated.invalid.join(", ")}.`);
  }
  const before = "role" in from ? FIXED_ROLE_CAPABILITIES[from.role] : from.capabilities;
  const diff = diffRoleCapabilities(before, validated.capabilities);

  const beforeFamilies = new Map<string, number>();
  for (const c of before) beforeFamilies.set(capabilityFamily(c), (beforeFamilies.get(capabilityFamily(c)) ?? 0) + 1);
  const afterFamilies = new Map<string, number>();
  for (const c of validated.capabilities) afterFamilies.set(capabilityFamily(c), (afterFamilies.get(capabilityFamily(c)) ?? 0) + 1);

  const surfacesOpened: string[] = [];
  const surfacesClosed: string[] = [];
  for (const [family, surface] of Object.entries(CAPABILITY_FAMILY_SURFACES)) {
    const had = (beforeFamilies.get(family) ?? 0) > 0;
    const has = (afterFamilies.get(family) ?? 0) > 0;
    if (!had && has) surfacesOpened.push(surface);
    if (had && !has) surfacesClosed.push(surface);
  }
  return { ...diff, surfacesOpened, surfacesClosed };
}

/** Every fixed role, as a comparison baseline for the editor. */
export function fixedRoleBaselines(): Record<AuthRole, readonly Capability[]> {
  return FIXED_ROLE_CAPABILITIES;
}

/** The full catalog, for the editor's picklist. */
export function catalogOptions(): readonly Capability[] {
  return CAPABILITIES;
}
