import { describe, expect, it } from "vitest";
import {
  DYNAMIC_FAMILIES,
  GENERIC_TECHNICAL_SUMMARY,
  eventPayloadSchema,
  isRegisteredAction,
  registeredActions,
  resolveEventDefinition,
  subjectDestination,
} from "@/domains/audit/events/registry";
import { SAFE_SUMMARY_ACTIONS, SAFE_SUMMARY_PREFIXES } from "@/domains/audit/queries";
import { checkRegistry, familyCoverageErrors, scanAuditEmits } from "../../scripts/check-audit-registry";

/*
 * The registry is the audit domain's contract for what an emitted action
 * means. These tests pin the three properties the spec locks: every action
 * the legacy safe-summary allowlist covers resolves to a full (Tier 1)
 * definition, so moving the allowlist behind the registry cannot fail closed
 * differently; unknown actions resolve to the generic technical default
 * instead of improvising meaning; and the registry and the emit sites cannot
 * drift apart (the scanner contract, re-run in-suite).
 */

const userActor = { label: "You", kind: "user" as const };
const systemActor = { label: "Polymath", kind: "system" as const };

describe("registry coverage", () => {
  it("every legacy safe-summary action is a registered Tier 1 (activity-visibility) definition", () => {
    const unregistered = [...SAFE_SUMMARY_ACTIONS].filter((action) => {
      const definition = resolveEventDefinition(action);
      return definition.visibility !== "activity" || !isRegisteredAction(action);
    });
    expect(unregistered).toEqual([]);
  });

  it("every dynamic-family expansion of the safe prefixes is registered at Tier 1", () => {
    for (const prefix of SAFE_SUMMARY_PREFIXES) {
      for (const suffix of DYNAMIC_FAMILIES[prefix] ?? []) {
        expect(resolveEventDefinition(`${prefix}${suffix}`).visibility, `${prefix}${suffix}`).toBe("activity");
      }
    }
  });

  it("every declared dynamic family expansion is registered", () => {
    for (const [prefix, suffixes] of Object.entries(DYNAMIC_FAMILIES)) {
      for (const suffix of suffixes) {
        expect(isRegisteredAction(`${prefix}${suffix}`), `${prefix}${suffix}`).toBe(true);
      }
    }
  });

  it("registers no action twice", () => {
    const actions = registeredActions();
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("capture.converted groups as the operation outcome and its step rows as steps", () => {
    expect(resolveEventDefinition("capture.converted").grouping.operation).toBe("outcome");
    expect(resolveEventDefinition("capture.zettels_created").grouping.operation).toBe("step");
  });
});

describe("unknown actions", () => {
  it("resolve to the generic technical default instead of improvising meaning", () => {
    const definition = resolveEventDefinition("totally.unknown_action");
    expect(definition.visibility).toBe("technical");
    expect(definition.category).toBe("workspace");
    expect(definition.attention).toBe("none");
    expect(definition.grouping.operation).toBe("standalone");
    expect(definition.sentence({}, userActor)).toBe(GENERIC_TECHNICAL_SUMMARY);
    expect(definition.sentence({}, systemActor)).toBe(GENERIC_TECHNICAL_SUMMARY);
  });

  it("resolves an unknown action without a routable subject destination", () => {
    expect(subjectDestination({ subjectType: "totally_unknown", subjectId: "abc" })).toBeNull();
  });
});

describe("sentence templates", () => {
  it("renders an actor-aware sentence for every registered action", () => {
    for (const action of registeredActions()) {
      const definition = resolveEventDefinition(action);
      for (const actor of [userActor, systemActor, { label: "Ada", kind: "agent" as const }]) {
        const sentence = definition.sentence({}, actor);
        expect(sentence.length > 0, `${action} for ${actor.kind}`).toBe(true);
        expect(sentence.includes("—"), `${action} renders an em dash`).toBe(false);
      }
    }
  });

  it("attributes the viewer as You and system actors as Polymath", () => {
    expect(resolveEventDefinition("capture.created").sentence({}, userActor)).toBe("You added a capture");
    expect(resolveEventDefinition("capture.created").sentence({}, systemActor)).toBe("Polymath added a capture");
  });
});

describe("destinations", () => {
  const cases: { subjectType: string; subjectId: string; href: string }[] = [
    { subjectType: "capture", subjectId: "cap1", href: "/command-center/inbox?id=cap1" },
    { subjectType: "task", subjectId: "task1", href: "/neuralflow/work?task=task1" },
    { subjectType: "contact", subjectId: "c1", href: "/command-center/relationships/contacts?id=c1" },
    { subjectType: "company", subjectId: "co1", href: "/command-center/relationships/companies/co1" },
    { subjectType: "document", subjectId: "doc1", href: "/polymath/library/doc1" },
    { subjectType: "run", subjectId: "run1", href: "/polymath/run1" },
  ];
  it.each(cases)("routes $subjectType to $href", ({ subjectType, subjectId, href }) => {
    expect(subjectDestination({ subjectType, subjectId })).toMatchObject({ href });
  });

  it("sends connector accounts to the integrations settings surface", () => {
    expect(subjectDestination({ subjectType: "external_account", subjectId: "ea1" })).toMatchObject({
      href: "/command-center/integrations",
    });
  });

  it("never routes a subject with no id", () => {
    expect(subjectDestination({ subjectType: "capture", subjectId: null })).toBeNull();
  });
});

describe("payload envelope", () => {
  it("accepts legacy rows (no version) and versioned envelopes with extra keys", () => {
    expect(eventPayloadSchema.safeParse({}).success).toBe(true);
    expect(eventPayloadSchema.safeParse({ version: 1, resultId: "n1" }).success).toBe(true);
  });

  it("rejects a non-integer version marker", () => {
    expect(eventPayloadSchema.safeParse({ version: "one" }).success).toBe(false);
  });
});

describe("scanner contract", () => {
  it("covers every action the tree emits (scan + registry agree)", () => {
    const findings = scanAuditEmits();
    expect([...familyCoverageErrors(), ...checkRegistry(findings)]).toEqual([]);
  });
});
