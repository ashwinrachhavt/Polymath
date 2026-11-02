import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWED_TOOLS } from "@/domains/agents/commands";
import { CAPABILITIES, LIMITS, PROVIDER_TOOLS, type Capability } from "@/domains/integrations/capabilities";
import { CAPABILITY_RISK } from "../../eve/polymath/evals/axiom-policy";
import { deriveInstantCapability, resolveInstantCapability } from "@/domains/integrations/instant-tools";
import catalogJsonRaw from "@/domains/integrations/instant-catalog.generated.json";

/*
 * Helpers for the Instant-namespace tests below. The generated JSON crosses a
 * regeneration boundary, so it is narrowed once here; a malformed file fails
 * these tests rather than the production gate.
 */
function catalogJson(): { toolkits: Array<{ slug: string; tools: Array<{ slug: string }> }> } {
  const value = catalogJsonRaw as unknown;
  if (typeof value !== "object" || value === null || !Array.isArray((value as { toolkits?: unknown }).toolkits)) {
    throw new Error("instant-catalog.generated.json is malformed; regenerate it.");
  }
  return value as { toolkits: Array<{ slug: string; tools: Array<{ slug: string }> }> };
}

function gainedInstantNames(): string[] {
  return DEFAULT_ALLOWED_TOOLS.filter((tool) => tool.startsWith("instant."));
}

/*
 * The capability catalog is the one place a provider capability is defined.
 * These tests pin the three names that have drifted apart before: the
 * capability spelled in a policy snapshot, the risk class the evals read, and
 * the MCP tool name a model calls. A mismatch here is a tool that is visible,
 * classified, and still unrouteable - or worse, routed under a class nobody
 * approved.
 *
 * The risk table is imported, never edited: it is the frozen vocabulary the
 * evals assert against, so this catalog has to agree with it, not the reverse.
 */

const entries = Object.entries(CAPABILITIES);
const capabilities = Object.keys(CAPABILITIES) as Capability[];

/*
 * Every capability the catalog names must have a row in the frozen risk table.
 * A capability with no row fails closed in every classifier that reads the
 * table, which ships as a tool that can never be granted. This list is empty on
 * purpose: a new unclassified capability fails here rather than at runtime.
 */
const UNCLASSIFIED: string[] = [];

describe("provider capability catalog", () => {
  it("has entries and every one is named for its own provider", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [capability, spec] of entries) {
      expect([
        "gmail",
        "github",
        "slack",
        "linear",
        "google-calendar",
        "google-drive",
        "google-docs",
        "google-sheets",
        "discord",
        "zoom",
        "calendly",
        "asana",
        "trello",
        "airtable",
        "canva",
        "hubspot",
        "stripe",
        "notion",
        "linkedin",
        "instagram",
      ]).toContain(spec.provider);
      // A provider's capability prefix is its name without separators
      // ("google-calendar" → "googlecalendar."), so one provider's ids stay
      // grouped even when the catalog row spells the provider with a dash.
      expect(capability.startsWith(`${spec.provider.replaceAll("-", "")}.`), capability).toBe(true);
    }
  });

  it("agrees with the risk table wherever the table has a row", () => {
    for (const [capability, spec] of entries) {
      if (UNCLASSIFIED.includes(capability)) continue;
      expect(CAPABILITY_RISK[capability], `${capability} must be in the risk table`).toBeDefined();
      expect(spec.riskClass, capability).toBe(CAPABILITY_RISK[capability]);
    }
  });

  it("classifies every capability in the frozen risk table", () => {
    const missing = capabilities.filter((capability) => CAPABILITY_RISK[capability] === undefined);
    expect(missing).toEqual(UNCLASSIFIED);
  });

  it("keeps the two frozen names", () => {
    // These are in every profile's frozen snapshot; renaming is a migration.
    expect(capabilities).toContain("gmail.read");
    expect(capabilities).toContain("gmail.send");
  });

  it("makes gmail.send a proposal, never an inline write", () => {
    expect(CAPABILITIES["gmail.send"].riskClass).toBe("external_write");
    expect(CAPABILITIES["gmail.send"].kind).toBe("proposal");
  });

  it("only classifies reads as reads", () => {
    for (const [capability, spec] of entries) {
      if (spec.kind === "read") expect(spec.riskClass, capability).toBe("read");
      if (spec.riskClass === "external_write") expect(spec.kind, capability).toBe("proposal");
    }
  });

  it("has unique tool names", () => {
    const tools = entries.map(([, spec]) => spec.tool);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it("routes every tool back to its own capability", () => {
    for (const [capability, spec] of entries) {
      expect(PROVIDER_TOOLS[spec.tool as keyof typeof PROVIDER_TOOLS], capability).toBe(capability);
    }
    // The mapping is surjective, not bijective: a second tool may share a
    // capability when it IS that capability under the same ceiling - the
    // Writer's draft tool is gmail.send (ASH-281), so one snapshot entry
    // governs the draft and the send. What must hold: no tool routes to a
    // capability the catalog does not know, and no tool name is claimed twice.
    const capabilities = new Set(entries.map(([capability]) => capability));
    for (const [tool, capability] of Object.entries(PROVIDER_TOOLS)) {
      expect(capabilities.has(capability), `${tool} -> ${capability}`).toBe(true);
    }
    expect(Object.keys(PROVIDER_TOOLS).length).toBeGreaterThanOrEqual(entries.length);
  });

  it("bounds results inside the limit the gateway clamps to", () => {
    expect(LIMITS.defaultResults).toBeGreaterThan(0);
    expect(LIMITS.defaultResults).toBeLessThanOrEqual(LIMITS.maxResults);
  });
});

/*
 * Polymath-native tools are not provider capabilities: they read Polymath's own
 * tables and never leave the workspace, so they have no provider row.
 *
 * `calendar.read` is a provider capability whose catalog row belongs to a
 * later slice; it is default-granted today, so the catalog test would
 * otherwise fail on a capability that is real but not yet defined here.
 * Listing it explicitly keeps the gap visible instead of widening the rule.
 * (`notion.read` left this list when the Notion read tools shipped.)
 */
// Polymath-native capabilities: they reach no provider, so they have no
// catalog row and never will.
const NATIVE_TOOLS = [
  "tasks.read",
  "documents.search",
  "wiki.read",
  "wiki.ingest",
  "wiki.lint",
  "notebook.open",
  "tasks.create",
  // No connected account or catalog row: the search provider is picked from
  // the environment (zero-key DuckDuckGo by default), and a fetch goes
  // through the workspace's own Firecrawl, never through a connection.
  "web.search",
  "web.fetch",
  "artifacts.revise",
  // ASH-283: Notion writes are proposal-only capabilities with a local
  // executor in the actions domain, not gateway-toolkit capabilities.
  "notion.page.append",
  "notion.page.create",
  // ASH-279 / ASH-306: first-party reads and propose-only operations whose
  // implementation lives in this repo rather than behind a provider toolkit.
  "meetings.debrief",
  // ASH-282: proposal-only; approval records the decision, no calendar call.
  "calendar.propose",
  "records.browse",
  // ASH-285: drafts a Linear-issue proposal note in this repo; never a
  // provider call, so no catalog row.
  "linear.issue.propose",
  // ASH-284: triage proposals persist in this repo; GitHub is never called,
  // so no catalog row.
  "github.issue.triage",
  // ASH-287: proposal-only; approval creates the contact locally.
  "crm.contact.create",
];
const DEFERRED_PROVIDER_CAPABILITIES = ["calendar.read"];

describe("the default profile's tools all resolve", () => {
  it("only grants a catalogued, native, explicitly deferred, or Instant-derived capability", () => {
    const instantNames = new Set(
      catalogJson().toolkits.flatMap((t) => t.tools.map((x) => deriveInstantCapability(t.slug, x.slug))),
    );
    const known = new Set<string>([
      ...capabilities,
      ...NATIVE_TOOLS,
      ...DEFERRED_PROVIDER_CAPABILITIES,
      ...instantNames,
    ]);
    for (const tool of DEFAULT_ALLOWED_TOOLS) {
      expect(known.has(tool), `${tool} is not a known capability`).toBe(true);
    }
  });

  it("defers only capabilities the risk table already knows", () => {
    // A deferred name that is not in the risk table is a typo, not a gap.
    for (const capability of DEFERRED_PROVIDER_CAPABILITIES) {
      expect(CAPABILITY_RISK[capability], capability).toBeDefined();
      expect(capabilities).not.toContain(capability);
    }
  });
});

/*
 * The Instant namespace (spec #316): derived capability names share the
 * gateway with hand-registered ones, so a collision would shadow a
 * hand-registered capability's grant or dispatch. These tests prove the
 * namespace cannot collide and the gained-array grant stays honest.
 */
describe("the Instant derived namespace cannot collide", () => {
  it("derives names that never shadow a hand-registered capability or tool", () => {
    const catalog = catalogJson();
    const adversarialSuffixes = [
      "gmail_search",
      "gmail_read_thread",
      "notion_search",
      "x1",
      "Mixed_Case",
      "with__dashes--and.dots",
    ];
    for (const toolkit of catalog.toolkits) {
      for (const suffix of [...adversarialSuffixes, ...toolkit.tools.map((t) => t.slug)]) {
        const name = deriveInstantCapability(toolkit.slug, suffix);
        expect(name.startsWith("instant."), name).toBe(true);
        expect(CAPABILITIES, name).not.toHaveProperty(name);
        expect(Object.values(PROVIDER_TOOLS), name).not.toContain(name);
        expect(resolveInstantCapability(name), name).toEqual({ toolkitSlug: toolkit.slug });
      }
    }
  });

  it("grants no instant.* name that shadows a hand-registered capability", () => {
    // The gained array in commands.ts carries the same names the generated
    // catalog derives; the point is that none of them is also a
    // hand-registered capability key (which would double-grant under two
    // vocabularies).
    const handRegistered = new Set<string>(capabilities);
    const instantGranted = gainedInstantNames();
    expect(instantGranted.length).toBeGreaterThan(0);
    for (const name of instantGranted) {
      expect(name.startsWith("instant."), name).toBe(true);
      expect(handRegistered.has(name), `${name} shadows a hand-registered capability`).toBe(false);
    }
  });
});

describe("the profile-upgrade gained array stays in step with the catalog", () => {
  it("grants only names that derive from the generated Instant catalog (or a known capability)", () => {
    // ensureProfile's gained array is not exported; the catalog-side half of
    // the grant is pinned here: every instant.* name the array could carry
    // must derive from the committed catalog, so an edit that drifts the two
    // lists fails the DEFAULT_ALLOWED_TOOLS pins above plus this direction.
    const derivable = new Set(
      catalogJson().toolkits.flatMap((t) => t.tools.map((x) => deriveInstantCapability(t.slug, x.slug))),
    );
    expect(derivable.size).toBeGreaterThan(0);
    for (const name of gainedInstantNames()) {
      expect(derivable.has(name), `${name} does not derive from the committed catalog`).toBe(true);
    }
  });
});
