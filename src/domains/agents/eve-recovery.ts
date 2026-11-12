import { and, asc, eq, inArray } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { bridgeHeaders, eveMount } from "./eve-driver";
import { agentRuns, runEvents } from "./schema";

/*
 * Recovery for a stranded eve session. When the dev process that owned a
 * session restarts, the run row still points at it and the new world refuses
 * to resume it. Eve answers with an opaque 500, so the only way to tell a
 * stranded session from a genuine failure is to ask the session itself.
 */

const RECOVERY_TIMEOUT_MS = 10_000;
const REPLAY_MAX_CHARS = 8_000;

/**
 * Whether the session behind a run is parked on the far side of a process
 * restart. A session whose recorded history ends at `session.waiting` was left
 * mid-turn by the old world and cannot be resumed by the new one; a live
 * session's tail is a running or completed turn, not a parked wait.
 */
export async function isEveSessionStranded(input: {
  agentName: string;
  sessionRef: string;
  auth: AuthContext;
}): Promise<boolean> {
  try {
    const response = await fetch(
      `${await eveMount(input.agentName)}/session/${encodeURIComponent(input.sessionRef)}/stream?follow=false`,
      {
        signal: AbortSignal.timeout(RECOVERY_TIMEOUT_MS),
        headers: { accept: "application/x-ndjson", ...bridgeHeaders(input.auth) },
      },
    );
    if (response.status === 404) return true;
    if (!response.ok) return false;
    const lines = (await response.text()).split("\n").filter((line) => line.trim() !== "");
    const tail = lines.at(-1);
    if (!tail) return false;
    const event = JSON.parse(tail) as { type?: unknown };
    return event.type === "session.waiting";
  } catch {
    // A probe that cannot answer must not be read as "stranded": the caller
    // then rethrows eve's original failure instead of replacing a live session.
    return false;
  }
}

/**
 * How many events the session has recorded, or null when the session cannot be
 * read. The stream's cursor is this count, so a caller comparing it against a
 * stored cursor learns whether that cursor still addresses this session: a
 * replacement session starts over at zero and would silently skip everything.
 */
export async function eveSessionEventCount(input: {
  agentName: string;
  sessionRef: string;
  auth: AuthContext;
}): Promise<number | null> {
  try {
    const response = await fetch(
      `${await eveMount(input.agentName)}/session/${encodeURIComponent(input.sessionRef)}/stream?follow=false`,
      {
        signal: AbortSignal.timeout(RECOVERY_TIMEOUT_MS),
        headers: { accept: "application/x-ndjson", ...bridgeHeaders(input.auth) },
      },
    );
    if (!response.ok) return null;
    return (await response.text()).split("\n").filter((line) => line.trim() !== "").length;
  } catch {
    return null;
  }
}

/**
 * The run's stored conversation, bounded for use as replacement context. The
 * most recent turns matter most, so the cap trims from the front.
 */
export async function replayContextForRun(runId: string, workspaceId: string): Promise<string> {
  const rows = await db
    .select({ sequence: runEvents.sequence, type: runEvents.type, data: runEvents.data })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, runId),
        eq(runEvents.workspaceId, workspaceId),
        inArray(runEvents.type, ["message", "reasoning"]),
      ),
    )
    .orderBy(asc(runEvents.sequence));
  const lines: string[] = [];
  for (const row of rows) {
    const data = (row.data ?? {}) as { role?: unknown; content?: unknown; text?: unknown };
    let speaker: string;
    let text: unknown;
    if (row.type === "reasoning") {
      speaker = "Assistant";
      text = data.text;
    } else {
      speaker = data.role === "assistant" ? "Assistant" : "User";
      text = data.content;
    }
    if (typeof text !== "string" || text.trim() === "") continue;
    lines.push(`${speaker}: ${text}`);
  }
  if (lines.length === 0) return "";
  const body = lines.join("\n\n");
  const tail = body.length > REPLAY_MAX_CHARS ? body.slice(-REPLAY_MAX_CHARS) : body;
  const trimmed = tail.length < body.length ? tail.slice(tail.indexOf("\n") + 1) : tail;
  return `Earlier in this conversation, before the live agent session was replaced:\n\n${trimmed}`;
}

/**
 * Start a fresh eve session carrying the run's conversation, then point the run
 * at it. Only called once the old session proved stranded; a replacement is
 * always a new create, so it needs a new operationId (the start's
 * `axiom-run-<id>` would dedupe against the dead one).
 */
export async function startReplacementSession(input: {
  runId: string;
  auth: AuthContext;
  agentName: string;
  message: string;
  skillId?: string;
  model?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.workspaceId, input.auth.workspaceId)))
    .limit(1);
  if (!run) return { ok: false, reason: "no such run" };

  const transcript = await replayContextForRun(input.runId, input.auth.workspaceId);
  const headers = bridgeHeaders(input.auth, {
    runId: input.runId,
    ...(input.skillId ? { skillId: input.skillId } : {}),
    ...(input.model ? { model: input.model } : {}),
  });
  const response = await fetch(`${await eveMount(input.agentName)}/session`, {
    method: "POST",
    signal: AbortSignal.timeout(RECOVERY_TIMEOUT_MS),
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      // The replay travels in the message, not in `context`: eve 0.76 creates
      // the session with the context attached but the model never receives it,
      // so a follow-up seeded that way answers as if the conversation were new.
      message: transcript ? `${transcript}\n\nNew message from the user:\n\n${input.message}` : input.message,
      operationId: `axiom-recover-${input.runId}-${crypto.randomUUID()}`,
    }),
  });
  if (!response.ok) return { ok: false, reason: `eve answered ${response.status}` };
  const body = (await response.json()) as { sessionId?: unknown };
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
    return { ok: false, reason: "eve answered without a session id" };
  }
  await db
    .update(agentRuns)
    .set({ sessionRef: body.sessionId, updatedAt: new Date() })
    .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.workspaceId, input.auth.workspaceId)));
  return { ok: true };
}
