import { readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_TOOLS } from "@/domains/superagent/assessor/eve";
import evalRead from "../../eve/specialist/agent/tools/orchestrator_eval_read";
import evalJudge from "../../eve/specialist/agent/tools/orchestrator_eval";
import evalDecide from "../../eve/specialist/agent/tools/orchestrator_eval_decide";

/*
 * Every allowedTools-pinned tool name must resolve to a registered eve tool.
 *
 * Value card
 * protects: the admission journey's liveness. Eve derives tool names from
 *   file names (eve docs, tools/overview.mdx: "The filename is the tool name
 *   the model sees"), so a pinned name with no matching file in the agent's
 *   tools/ directory silently never reaches the model. The assessor's judge
 *   session then cannot call the eval protocol: it finishes in prose, and the
 *   person's message dies with "This run has no agent session." — the P1 the
 *   verification wave originally hit (the three tools were missing entirely).
 * fails_when: a specialist tool file is renamed or deleted, or a new name is
 *   added to EVAL_TOOLS (the pin the assessor profile seed and the Eve session
 *   create both spread) without a matching file — the pin drifts from the
 *   registry eve derives at runtime and the wedge returns without any error
 *   anywhere.
 * why_new: the eval-protocol tools shipped with no test files at all; nothing
 *   pinned the pin-to-registry seam, and the original break was found by a
 *   live drive, not by CI.
 * seam: the specialist agent's tools/ directory read the way eve reads it
 *   (file stem = registered name), plus direct imports proving each pinned
 *   file actually defines a tool with an execute function.
 * no_claim: the tools' runtime behaviour (resolveAssessment binding, the
 *   judge/read/decide semantics — the assessor bridge specs own those), the
 *   profile seed's database write, and eve's loader internals.
 *
 * Scope note: the profile's allowedTools carries two vocabularies in this
 * codebase — dotted catalog capabilities (tasks.read and friends, checked
 * inside tool handlers against the run's frozen snapshot) and eve tool names
 * passed to the session create. Only the second is a pin into eve's file-name
 * registry, so only the assessor's EVAL_TOOLS is guarded here.
 */

const toolDir = join(import.meta.dirname, "../../eve/specialist/agent/tools");
const registeredNames = new Set(
  readdirSync(toolDir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => basename(file, ".ts")),
);

const pinnedDefinitions: Record<(typeof EVAL_TOOLS)[number], { execute: unknown }> = {
  orchestrator_eval_read: evalRead as { execute: unknown },
  orchestrator_eval: evalJudge as { execute: unknown },
  orchestrator_eval_decide: evalDecide as { execute: unknown },
};

describe("every allowedTools-pinned tool name resolves to a registered eve tool", () => {
  it.each(EVAL_TOOLS)("%s is exposed by the specialist agent's tool directory", (name) => {
    expect(
      registeredNames.has(name),
      `EVAL_TOOLS pins "${name}" but eve/specialist/agent/tools/ has no ${name}.ts — eve derives tool names from file names, so the judge session would silently lose the tool`,
    ).toBe(true);
  });

  it.each(EVAL_TOOLS)("%s defines an executable tool", (name) => {
    const definition = pinnedDefinitions[name];
    expect(definition, `the pinned tool "${name}" has no default tool definition`).toBeTruthy();
    expect(typeof definition.execute).toBe("function");
  });

  it("pins nothing that is not also a real file (no extra keys snuck into the map)", () => {
    expect(Object.keys(pinnedDefinitions).sort()).toEqual([...EVAL_TOOLS].sort());
  });
});
