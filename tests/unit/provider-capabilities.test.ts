import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWED_TOOLS } from "@/domains/agents/commands";
import { CAPABILITIES, LIMITS, PROVIDER_TOOLS, type Capability } from "@/domains/integrations/capabilities";
import { CAPABILITY_RISK } from "../../eve/alfred/evals/axiom-policy";

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
        "discord",
        "zoom",
        "calendly",
        "asana",
        "trello",
        "airtable",
        "canva",
        "hubspot",
        "stripe",
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
    expect(Object.keys(PROVIDER_TOOLS).length).toBe(entries.length);
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
 * `calendar.read` and `notion.read` are provider capabilities whose catalog
 * rows belong to later slices; they are default-granted today, so the catalog
 * test would otherwise fail on a capability that is real but not yet defined
 * here. Listing them explicitly keeps the gap visible instead of widening the
 * rule.
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
];
const DEFERRED_PROVIDER_CAPABILITIES = ["calendar.read", "notion.read"];

describe("the default profile's tools all resolve", () => {
  it("only grants a catalogued, native, or explicitly deferred capability", () => {
    const known = new Set<string>([...capabilities, ...NATIVE_TOOLS, ...DEFERRED_PROVIDER_CAPABILITIES]);
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
