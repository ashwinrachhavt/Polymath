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

/** The provider's single proposal-kind capability, or null. */
export function writeCapability(provider: Provider): Capability | null {
  const found = Object.entries(CAPABILITIES).find(
    ([, spec]) => spec.provider === provider && spec.kind === "proposal",
  );
  return found ? (found[0] as Capability) : null;
}

/** The tier that grants the write capability, or null when none does. */
function writeTierId(provider: Provider, capability: Capability): string | null {
  return PROVIDER_TIERS[provider]?.find((tier) => tier.capabilities.includes(capability))?.id ?? null;
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
    ? readCapabilities.filter((capability) => tiers.find((t) => t.id === currentTier)?.capabilities.includes(capability))
    : [];
  // Read is on only when the tier grants reads and every granted read is
  // enabled: a single switched-off read means the switch state is off, which
  // is what the person toggling expects to see.
  const readOn = grantedReads.length > 0 && grantedReads.every((capability) => !off.has(capability));

  const write = writeCapability(provider);
  if (!write) {
    return { read: { available: readAvailable, on: readOn }, write: null };
  }

  const tierId = writeTierId(provider, write);
  const writeOn = currentTier === tierId && !off.has(write);

  return {
    read: { available: readAvailable, on: readOn },
    write: {
      available: tierId !== null,
      on: writeOn,
      // gmail's proposal is a send, so the switch says what it does.
      label: write === "gmail.send" ? "Send" : "Write",
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
    const write = writeCapability(provider);
    if (!write) return [];
    const writeTier = tiers.find((t) => t.capabilities.includes(write));
    if (!writeTier) return [];
    // Already on the write tier: the capability enable alone settles it, and
    // a same-tier set would only burn a version bump.
    if (tier && tier.id !== writeTier.id) {
      steps.push({ kind: "tier", tierId: writeTier.id, expectedVersion: version++ });
    }
    if (off.has(write)) {
      steps.push({ kind: "capability", capability: write, expectedVersion: version++, enabled: true });
    }
    return steps;
  }

  if (!tier) {
    // Unknown or unset tier: the switch must still do what it says. Raise to
    // the lowest tier first, then enable its reads (some may already be
    // recorded as disabled on the account).
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
