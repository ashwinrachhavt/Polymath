import { CAPABILITIES, PROVIDER_TIERS, type Capability, type Provider } from "./capabilities";

/*
 * The owner-facing Read/Write switch model over the tier catalog. A person
 * thinks in "can agents read this" and "can agents act", not in tier ids, so
 * this module maps the catalog into at most two switches. The tier remains
 * the enforcement ceiling; a switch state only ever describes or narrows it.
 *
 * Pure by design: the component in connector-controls.tsx renders from this
 * and the unit test pins it, so the switch copy and the gateway's live checks
 * cannot drift apart silently.
 */

export type ToggleState = {
  read: { available: boolean; on: boolean };
  write: { available: boolean; on: boolean; label: string } | null;
};

/** All provider writes share the owner's Write switch. */
function writeCapabilities(provider: Provider): Capability[] {
  return Object.entries(CAPABILITIES)
    .filter(([, spec]) => spec.provider === provider && spec.kind === "proposal")
    .map(([id]) => id as Capability);
}

export function accessToggleState(provider: Provider, currentTier: string | null, disabled: string[]): ToggleState {
  const tiers = PROVIDER_TIERS[provider] ?? [];
  const readCapabilities = Object.entries(CAPABILITIES)
    .filter(([, spec]) => spec.provider === provider && spec.kind === "read")
    .map(([id]) => id as Capability);

  // A tier grants reads when any read-kind capability appears in its list;
  // read is available when the provider's lowest tier grants one.
  const lowest = tiers[0];
  const readAvailable = Boolean(
    lowest && lowest.capabilities.some((capability) => readCapabilities.includes(capability)),
  );

  const off = new Set(disabled);
  const grantedReads = currentTier
    ? readCapabilities.filter((capability) =>
        tiers.find((t) => t.id === currentTier)?.capabilities.includes(capability),
      )
    : [];
  // Read is on only when the tier grants reads and every granted read is
  // enabled: a single switched-off read means the switch state is off, which
  // is what the person toggling expects to see.
  const readOn = grantedReads.length > 0 && grantedReads.every((capability) => !off.has(capability));

  const writes = writeCapabilities(provider);
  if (writes.length === 0) return { read: { available: readAvailable, on: readOn }, write: null };
  const granted = tiers.find((candidate) => candidate.id === currentTier)?.capabilities ?? [];

  return {
    read: { available: readAvailable, on: readOn },
    write: {
      available: true,
      on: writes.every((capability) => granted.includes(capability) && !off.has(capability)),
      label: "Write",
    },
  };
}

/*
 * The server-action plan behind one switch flip, pure so the unit test can
 * pin the sequence the component issues. Each step bumps the account version,
 * so a later step's expectedVersion is its index plus the starting version.
 *
 * A tier-less or unresolvable current tier makes every toggle meaningful:
 * Read ON raises the account to the lowest tier (the command would reject a
 * capability enable outside the tier), then enables the granted reads.
 */
export type ToggleStep =
  | { kind: "tier"; tierId: string; expectedVersion: number }
  | { kind: "capability"; capability: Capability; expectedVersion: number; enabled: boolean };

export function planToggleSteps(input: {
  provider: Provider;
  currentTier: string | null;
  disabled: string[];
  toggle: "read" | "write";
  on: boolean;
}): ToggleStep[] {
  const { provider, currentTier, disabled, toggle, on } = input;
  const tiers = PROVIDER_TIERS[provider] ?? [];
  const tier = tiers.find((t) => t.id === currentTier);
  const off = new Set(disabled);
  const steps: ToggleStep[] = [];
  let version = 0;

  if (toggle === "write") {
    const writes = writeCapabilities(provider);
    if (!writes.length) return [];
    if (!on) {
      for (const capability of writes) {
        if (tier?.capabilities.includes(capability) && !off.has(capability))
          steps.push({ kind: "capability", capability, expectedVersion: version++, enabled: false });
      }
      return steps;
    }
    const writeTier = tiers.find((candidate) =>
      writes.every((capability) => candidate.capabilities.includes(capability)),
    );
    if (!writeTier) return [];
    if (!tier || tier.id !== writeTier.id)
      steps.push({ kind: "tier", tierId: writeTier.id, expectedVersion: version++ });
    for (const capability of writes) {
      if (off.has(capability))
        steps.push({ kind: "capability", capability, expectedVersion: version++, enabled: true });
    }
    return steps;
  }

  if (!tier) {
    // Unknown or unset tier: the switch must still do what it says. Read OFF
    // has nothing to disable — no tier grants reads — so it is a no-op. Read
    // ON raises to the lowest tier first, then enables its reads (some may
    // already be recorded as disabled on the account).
    if (!on) return [];
    const lowest = tiers[0];
    if (!lowest) return [];
    steps.push({ kind: "tier", tierId: lowest.id, expectedVersion: version++ });
    for (const capability of lowest.capabilities) {
      if (CAPABILITIES[capability]?.kind === "read" && off.has(capability)) {
        steps.push({ kind: "capability", capability, expectedVersion: version++, enabled: true });
      }
    }
    return steps;
  }

  if (on) {
    for (const capability of tier.capabilities) {
      if (CAPABILITIES[capability]?.kind === "read" && off.has(capability)) {
        steps.push({ kind: "capability", capability, expectedVersion: version++, enabled: true });
      }
    }
  } else {
    for (const capability of tier.capabilities) {
      if (CAPABILITIES[capability]?.kind === "read" && !off.has(capability)) {
        steps.push({ kind: "capability", capability, expectedVersion: version++, enabled: false });
      }
    }
  }
  return steps;
}
