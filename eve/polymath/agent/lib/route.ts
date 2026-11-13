import { recordRoundEvent } from "../../../../src/domains/agents/event-bridge";
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { routeTurn, type TurnRoute } from "../../../../src/domains/agents/turn-routing";
import { smallModelId } from "../../../../src/domains/agents/models";
import { httpJevClient } from "../../../../src/integrations/jev/client";
import { jevClassifier, type ClassifyJudger } from "../../../../src/integrations/jev/provider";
import { catalogModel } from "./model";

/*
 * One routing decision per turn, shared by every model call in it.
 *
 * The model resolver runs before each step; routing the same message again on
 * every step would repeat the Jev call and could flip the lane mid-turn. The
 * decision is memoised per session and message. A process restart recomputes
 * it, which is the same decision for rule-routed turns and almost always for
 * the rest; the turn's earlier steps are already done either way.
 */

const MEMO_LIMIT = 500;
const memo = new Map<string, Promise<TurnRoute>>();
/** Each session's latest decision, so a sub-agent works in its parent turn's lane. */
const latestBySession = new Map<string, Promise<TurnRoute>>();

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value);
  if (map.size > MEMO_LIMIT) map.delete(map.keys().next().value as string);
}

type Message = { role: string; content: unknown };

/**
 * The text of a message. Client context (the owner's background brief) is
 * prepended to the first turn as earlier parts, so the person's own words are
 * the last text part.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = content.filter(
    (part): part is { type: "text"; text: string } =>
      Boolean(part) && typeof part === "object" && part.type === "text" && typeof part.text === "string",
  );
  return texts.at(-1)?.text ?? "";
}

/** The person's message that started this turn. */
export function latestUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user") return textOf(message.content).trim();
  }
  return "";
}

/**
 * Jev for this caller. A workspace caller gets the metered judger (quota
 * ledger per workspace). The local eval and TUI identity has no workspace to
 * meter against, so outside production it calls Jev directly; in production a
 * caller without a workspace gets no Jev and routes by the small model.
 */
function judgeFor(workspaceId: string | null): ClassifyJudger | undefined {
  if (workspaceId) return jevClassifier(workspaceId);
  if (process.env.NODE_ENV === "production" || !process.env.TYPESAFE_API_KEY) return undefined;
  return {
    async judge(input) {
      const response = await httpJevClient(process.env).systemOne({ state: input.state, questions: input.questions });
      return { model: response.model, answers: response.answers, usage: response.usage };
    },
  };
}

function smallModel() {
  try {
    return catalogModel(smallModelId());
  } catch {
    return undefined;
  }
}

/** Records the decision on the run's timeline so the lane and its confidence are visible per turn. */
async function logRoute(sessionId: string, workspaceId: string, route: TurnRoute): Promise<void> {
  try {
    const run = await getRunBySessionRef(sessionId, workspaceId);
    if (!run) return;
    await recordRoundEvent({ runId: run.id, workspaceId, type: "route", data: route });
  } catch (cause) {
    console.error("turn routing: recording the route failed", cause);
  }
}

export function routeForTurn(input: {
  sessionId: string;
  /** Set inside a sub-agent: the session that delegated to it. */
  parentSessionId?: string;
  workspaceId: string | null;
  messages: readonly Message[];
}): Promise<TurnRoute> {
  // A sub-agent's message is its parent's brief, not the person's words: it
  // works in the lane the parent's turn was routed to.
  const inherited = input.parentSessionId ? latestBySession.get(input.parentSessionId) : undefined;
  if (inherited) return inherited;

  const text = latestUserText(input.messages);
  const key = `${input.sessionId}\u0000${text}`;
  const known = memo.get(key);
  if (known) {
    remember(latestBySession, input.sessionId, known);
    return known;
  }

  const decided = routeTurn({ text, judge: judgeFor(input.workspaceId), smallModel: smallModel() });
  remember(memo, key, decided);
  remember(latestBySession, input.sessionId, decided);
  if (input.workspaceId) {
    const workspaceId = input.workspaceId;
    void decided.then((route) => logRoute(input.sessionId, workspaceId, route));
  }
  return decided;
}
