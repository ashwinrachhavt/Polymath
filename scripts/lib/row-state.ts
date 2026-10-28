import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * Row-state classification, shared by the inventory generator and the test that
 * enforces it.
 *
 * This lives in one module on purpose. A test that re-implements the classifier
 * only proves the test agrees with itself; the generator silently reporting
 * "0 defects" while a new mutable table shipped unguarded is exactly the failure
 * this is meant to prevent. One function, two callers, so a change in the rule
 * moves both at once and any disagreement is a compile error rather than a
 * green build.
 */

export type RowState = "versioned" | "append-only" | "mutable-unversioned";

/*
 * A guard is one mechanism, not a table's whole story. Tables routinely have
 * several at once: runtime_signals increments `attempts` in-statement, guards the
 * `status` transition in the WHERE clause, and has a trigger freezing its payload.
 * Collapsing that to a single label overstates whichever mechanism got named and
 * lets someone delete the others believing the trigger covers them.
 */
export type GuardKind = "atomic-counter" | "app-cas" | "trigger-immutable" | "lease";

export type Guard = {
  kind: GuardKind;
  /** What the mechanism actually does, in one sentence. */
  detail: string;
  /** Where to check it. A reader must be able to verify this without guessing. */
  evidence: string;
  /**
   * Columns the mechanism constrains. Required for trigger-immutable, where the
   * test parses the trigger body and asserts the claim is true; a trigger that
   * exists but does not touch the named column is the failure this prevents.
   */
  columns?: string[];
  /**
   * Required for `lease`. A lease protects the writer, not the row: nothing in the
   * database stops a second caller that never takes it. So a lease is only a guard
   * while it is the single entry path, and that has to be named and tested rather
   * than assumed.
   *
   * Keyed by function so the permission is per-entry-point, not per-table. A file
   * allowed to call the leased path is not thereby allowed to call the one that
   * bypasses the lease — collapsing the two is how a bypass becomes invisible.
   * An empty array means the function must have no production caller.
   */
  singleEntryPath?: { callers: Record<string, string[]> };
};

/*
 * Four states (revised 2026-10-27, twice, after reviewing DB triggers):
 *
 *   append-only           written once, never updated
 *   versioned             carries `version`, guarded writes
 *   guarded, no version   mutable, concurrency handled by the mechanisms declared
 *                         here. Every mechanism is listed separately.
 *
 * Anything undeclared is a defect.
 *
 * A declaration without cited evidence is the mistake this module exists to
 * prevent: an earlier version recorded these from table *shape* alone, and two of
 * four were wrong. A similar error followed: reading "a trigger exists" as "the
 * trigger guards the state machine", when for runtime_signals it guards only
 * identity and payload. Quote the mechanism, name the columns it touches.
 */
export type TableDeclaration = { guards: Guard[] };

export const GUARDED_WITHOUT_VERSION: Record<string, TableDeclaration> = {
  "integrations.provider_quota_buckets": {
    guards: [
      {
        kind: "atomic-counter",
        detail: "increment happens in the statement: SET reserved = reserved + EXCLUDED.reserved, with a guard clause in WHERE",
        evidence: "src/integrations/providers/quota.ts:72-96",
      },
    ],
  },
  "agents.runtime_signals": {
    guards: [
      {
        kind: "atomic-counter",
        detail: "attempts incremented in the same statement that advances status, so an attempt is never lost on crash",
        evidence: "src/domains/agents/runtime-persistence.ts:301",
        columns: ["attempts"],
      },
      {
        kind: "app-cas",
        detail: "status transitions are compare-and-set in the WHERE clause: status in ('pending','failed','unknown'). The trigger does NOT constrain status, so this is the only thing preventing two senders.",
        evidence: "src/domains/agents/runtime-persistence.ts:301",
        columns: ["status"],
      },
      {
        kind: "trigger-immutable",
        detail: "BEFORE UPDATE trigger freezes execution_id, signal_key, payload_revision and payload_hash; it does not touch status",
        evidence: "src/db/migrations/0150_runtime_persistence.sql:145-160",
        columns: ["execution_id", "signal_key", "payload_revision", "payload_hash"],
      },
    ],
  },
  "agents.tool_invocations": {
    guards: [
      {
        kind: "trigger-immutable",
        detail: "BEFORE UPDATE trigger freezes request identity (run_id, invocation_id, tool_name, arguments_hash, effect_class) and refuses to reopen a terminal state, so the state machine is enforced by the database rather than by the writer",
        evidence: "src/db/migrations/0150_runtime_persistence.sql:189-202",
        columns: ["run_id", "invocation_id", "tool_name", "arguments_hash", "effect_class", "state"],
      },
      {
        kind: "app-cas",
        detail: "belt and braces on the same transition: requested -> in_flight, then settle only where state not in ('succeeded','failed')",
        evidence: "src/domains/agents/runtime-persistence.ts:374,383",
        columns: ["state"],
      },
    ],
  },
  "knowledge.document_enrichment": {
    guards: [
      {
        kind: "lease",
        detail: "the only production path to the stage writes is extractDocument after it claims the document_extractions lease; enrichAfterText is reached only from that function. This holds because retryDocumentEnrichment, which calls advanceDocumentEnrichment directly and bypasses the lease, has no production caller - the moment one appears this declaration is false.",
        evidence: "src/domains/knowledge/extraction.ts:83,176,271",
        singleEntryPath: {
          callers: {
            // Reached only from extractDocument, after the lease is claimed.
            advanceDocumentEnrichment: ["src/domains/knowledge/extraction.ts"],
            // Bypasses the lease. Empty on purpose: a production caller here
            // makes the lease declaration false, and the test fails closed.
            retryDocumentEnrichment: [],
          },
        },
      },
    ],
  },
};

/*
 * Tables that carry a version column AND a trigger freezing security-relevant
 * columns. Filing these under "versioned" alone would make them sound like
 * ordinary optimistically-concurrent rows; the trigger is the stronger guarantee
 * and it exists so the row cannot widen its own authority mid-flight.
 */
export const VERSIONED_WITH_TRIGGER_INVARIANT: Record<string, TableDeclaration> = {
  "agents.agent_runs": {
    guards: [
      {
        kind: "trigger-immutable",
        detail: "admission inputs fixed at start: policy_snapshot, agent_profile_id and profile_revision_id cannot change once set, so a run cannot widen its own authority mid-flight",
        evidence: "src/db/migrations/0150_runtime_persistence.sql:40-56",
        columns: ["policy_snapshot", "agent_profile_id", "profile_revision_id"],
      },
    ],
  },
  "agents.agent_delegation_grants": {
    guards: [
      {
        kind: "trigger-immutable",
        detail: "the grant's content is frozen, including allowed_operations and allowed_resources, so an issued delegation cannot be widened in place",
        evidence: "src/db/migrations/0171_agent_delegation_grants.sql:55-70",
        columns: ["allowed_operations", "allowed_resources"],
      },
    ],
  },
};

export function classifyRowState(body: string): RowState {
  const versioned = body.includes("...mutable") || /\bversion:\s*(integer|int)/.test(body);
  if (versioned) return "versioned";
  const mutable = /\b(updated_at|updatedAt|archived_at|archivedAt)\b/.test(body);
  return mutable ? "mutable-unversioned" : "append-only";
}

export type TableEntry = { domain: string; name: string; body: string; key: string; state: RowState };

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (name.endsWith(".ts")) acc.push(path);
  }
  return acc;
}

/** Every pgTable body under src/domains, brace-matched so a nested literal cannot truncate it. */
export function readTables(root: string): TableEntry[] {
  const out: TableEntry[] = [];
  const files = walk(join(root, "src/domains")).filter((f) => readFileSync(f, "utf8").includes("pgTable("));
  for (const file of files.sort()) {
    const src = readFileSync(file, "utf8");
    const domain = relative(join(root, "src/domains"), file).split("/")[0];
    const re = /pgTable\(\s*['"]([a-z0-9_]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const open = src.indexOf("{", m.index + m[0].length - 1);
      let depth = 0;
      let i = open;
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) break;
      }
      const body = src.slice(open, i + 1);
      out.push({ domain, name: m[1], body, key: `${domain}.${m[1]}`, state: classifyRowState(body) });
    }
  }
  return out;
}
