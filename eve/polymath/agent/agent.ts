import { defineAgent, defineDynamic } from "eve";
// Relative, not "@/...": eve bundles from its own package root (see hooks/bridge.ts).
import { smallModelId } from "../../../src/domains/agents/models";
import { TURN_INPUT_TOKEN_CAP } from "../../../src/domains/agents/lane-policy";
import { withLane } from "./lib/lane-model";
import { routedModel } from "./lib/model";
import { routeForTurn } from "./lib/route";

/*
 * Polymath: one first-party agent (agents/product.md — not a persona zoo).
 *
 * Every turn is routed first (lib/route.ts → src/domains/agents/turn-routing.ts)
 * and the lane decides the turn: which model answers, which tools it sees, its
 * step and token caps, and whether a sub-agent (research, deep library
 * search) does the gathering (src/domains/agents/lane-policy.ts, enforced by
 * lib/lane-model.ts).
 *
 * The run freezes its model at start (`agent_runs.model`, copied from the
 * profile's `model_policy.primary`), so a conversation cannot change model
 * mid-thread and the spend row and the executing model are the same value.
 * `runModel` is passed by the session context (`axiom-run-model`); when it is
 * absent the env var decides, which is what evals and the local TUI use. The
 * one exception is the quick lane (greetings, thanks), which runs on the small
 * model by owner decision (2026-11-13).
 *
 * `modelContextWindowTokens` rides in the resolver selection (a dynamic model
 * cannot declare it at the top level); it feeds the compaction trigger, which
 * otherwise demands AI Gateway catalog metadata an unlisted model lacks.
 */
const CONTEXT_WINDOW_TOKENS = 128_000;

export default defineAgent({
  /*
   * No optional default tools. Eve otherwise advertises bash, read_file,
   * write_file, glob, grep, and friends to every agent; for a chief-of-staff
   * agent that is both a reachable shell on the host and thousands of tokens of
   * tool schema on every step (which showed up as a bloated request and a
   * free-tier rate limit during the first app-level run). Polymath reaches the
   * world through the authored tools in agent/tools/, which are policy-gated;
   * nothing here should have a shell.
   */
  defaultTools: false,
  // step.started is the only scope that may return a live LanguageModel
  // (session/turn selections must be serializable gateway id strings).
  model: defineDynamic({
    events: {
      // The run's frozen model rides in the signed bridge token, which the
      // channel publishes as a session attribute; eve has no per-run config
      // channel before the first step. The env var is the fallback for evals
      // and the TUI, which have no run row.
      "step.started": async (event, ctx) => {
        const attributes = ctx.session.auth.current?.attributes;
        const fromSession = attributes?.model;
        // The run's frozen model; the resolver falls back to the catalog default.
        const runModel =
          (typeof fromSession === "string" ? fromSession : process.env.AXIOM_RUN_MODEL) ??
          process.env.GEMINI_AGENT_MODEL;
        const workspaceId = typeof attributes?.workspaceId === "string" ? attributes.workspaceId : null;
        // eve's resolver type omits the lineage a sub-agent session carries at runtime.
        const parent = (ctx.session as { parent?: { rootSessionId?: string } }).parent;
        const route = await routeForTurn({
          sessionId: ctx.session.id,
          turnId: String((event as { data?: { turnId?: unknown } }).data?.turnId ?? ""),
          parentSessionId: parent?.rootSessionId,
          workspaceId,
          messages: ctx.messages,
        });
        const model = await routedModel(workspaceId, route.lane === "quick" ? smallModelId() : runModel);
        return { model: withLane(model, route), modelContextWindowTokens: CONTEXT_WINDOW_TOKENS };
      },
    },
  }),
  /*
   * Summarize at about 30k tokens instead of eve's default 90% of the window
   * (115k). The summary runs on the turn's model, so it goes through the same
   * resolver and allowance as every other call.
   */
  compaction: { thresholdPercent: TURN_INPUT_TOKEN_CAP / CONTEXT_WINDOW_TOKENS },
});
