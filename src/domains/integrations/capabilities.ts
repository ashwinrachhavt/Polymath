/*
 * The provider capability catalog: one authoritative answer to "what can this
 * capability do, and under what limit".
 *
 * Capability names exist in three vocabularies that must never drift:
 *  - the frozen policy snapshot and `DEFAULT_ALLOWED_TOOLS`, which spell the
 *    capability (`gmail.read`);
 *  - the risk table the evals read, `eve/alfred/evals/axiom-policy.ts`, which
 *    assigns it a class;
 *  - the MCP tool name a model calls (`gmail_search`).
 * This module is the single map between them. Everything downstream - the
 * gateway, the tools, the proposal path - reads it instead of restating a name.
 *
 * `kind` is the authorization shape, not the risk class:
 *  - `read` runs inside a turn and returns data;
 *  - `proposal` only ever writes an action proposal for the owner to decide.
 * There is deliberately no `write` kind. A provider write is reachable only
 * through the approved-effect executor, never from a model-driven tool call.
 *
 * The risk class is narrower than the spec's five: only `read` and
 * `external_write` have shipped capabilities. Keeping the union narrow means a
 * new class (a prepare or sensitive write) needs an explicit change here, not
 * a silently accepted string.
 *
 * `integration_catalog.risk_by_capability` remains display metadata for the
 * connect screen. Nothing gates on it.
 */

export type Provider = "gmail";

export type CapabilitySpec = {
  provider: Provider;
  /** "read" runs inside a turn; "proposal" only ever creates a proposal. */
  kind: "read" | "proposal";
  riskClass: "read" | "external_write";
  /** MCP tool name the model calls. */
  tool: string;
};

/*
 * Only Gmail ships in this slice. Linear, GitHub, Vercel, and Notion rows are
 * owned by later slices; leaving them out is what keeps this catalog honest
 * about what the gateway can actually route today.
 *
 * `gmail.read` and `gmail.send` are fixed names: they are in
 * `DEFAULT_ALLOWED_TOOLS` and in every frozen policy snapshot, so renaming one
 * is a migration with no benefit.
 */
export const CAPABILITIES = {
  "gmail.read": { provider: "gmail", kind: "read", riskClass: "read", tool: "gmail_search" },
  "gmail.thread.read": { provider: "gmail", kind: "read", riskClass: "read", tool: "gmail_read_thread" },
  "gmail.send": { provider: "gmail", kind: "proposal", riskClass: "external_write", tool: "gmail_send" },
} as const satisfies Record<string, CapabilitySpec>;

export type Capability = keyof typeof CAPABILITIES;

/*
 * Tool name to capability, for dispatch. This is the inverse of the `tool`
 * field above; tests/unit/provider-capabilities.test.ts proves the two maps
 * agree, so a tool added to one and not the other fails there rather than
 * becoming an unroutable 404 at runtime.
 */
export const PROVIDER_TOOLS = {
  gmail_search: "gmail.read",
  gmail_read_thread: "gmail.thread.read",
  gmail_send: "gmail.send",
} as const satisfies Record<string, Capability>;

/*
 * The runtime bounds the gateway enforces. They live here, next to the
 * capabilities they bound, so a limit is reviewed with the thing it constrains
 * instead of in a settings screen.
 *
 * maxResponseBytes is a truncation point, not a rejection point: a result over
 * the bound is cut at the last complete record with an explicit marker, because
 * a truncated answer the model can see is safer than a silent empty one.
 */
export const LIMITS = {
  defaultResults: 25,
  maxResults: 100,
  maxResponseBytes: 65_536,
  callsPerRunPerProvider: 50,
  callsPerWorkspacePerMinute: 60,
  effectsPerRun: 5,
} as const;
