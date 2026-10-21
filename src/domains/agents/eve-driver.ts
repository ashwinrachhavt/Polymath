import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { bridgeSecret, signBridgeToken } from "./bridge-token";
import { agentRuns } from "./schema";
import type { SessionDriver } from "./engine";

/*
 * The eve-backed SessionDriver: the only src/ file that talks to a running eve
 * agent over HTTP. It speaks the eve channel's REST surface (POST /eve/v1/session)
 * rather than importing eve, so the app side stays free of the eve SDK.
 *
 * The run's id and the eve session id are different namespaces on purpose: eve
 * allocates `wrun_…` ids and does not accept caller-assigned ones (eve protocol
 * docs). The run row carries the allocated id in `session_ref`, and the bridge
 * resolves back through it. `operationId` gives create-once semantics so a
 * retried start cannot fork a second session for the same run.
 *
 * ponytail: direct fetch, no client SDK. Enough while the surface is one
 * create call; switch to `eve/client` when signal/cancel grow real bodies.
 */

type EveTarget =
  // A standalone eve server; its REST surface is {base}/eve/v1.
  | { kind: "standalone"; base: string }
  // Eve rides the app's own origin through the withEve service: {origin}/eve/<agent>/v1.
  | { kind: "same-origin"; base: string };

/*
 * Where the next Eve call goes. A relative same-origin path is never returned:
 * server-side fetch requires an absolute URL, which is what broke every run on
 * Vercel when EVE_BASE_URL was unset.
 */
function eveTarget(): EveTarget | null {
  const explicit = process.env.EVE_BASE_URL;
  if (explicit && explicit.trim().length > 0) return { kind: "standalone", base: explicit.replace(/\/+$/, "") };
  // A deployed environment routes to its own origin. The dev-server state file
  // below is local-only, and a developer with `eve dev` running would otherwise
  // shadow the deployment the app is actually serving from.
  const vercelHost = process.env.VERCEL_BRANCH_URL ?? process.env.VERCEL_URL;
  if (vercelHost) return { kind: "same-origin", base: `https://${vercelHost}` };
  // Dev: the eve dev server publishes its port here.
  try {
    // ponytail: sync fs read at call time; fine at run-start frequency.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const state = require("fs").readFileSync(
      `${process.cwd()}/eve/alfred/.eve/dev-server-state.v1.json`,
      "utf8",
    ) as string;
    const parsed = JSON.parse(state) as { url?: string };
    if (parsed.url) return { kind: "standalone", base: parsed.url.replace(/\/+$/, "") };
  } catch {
    // No dev server; fall through to the local same-origin mount.
  }
  // Local `next start` serves the app and the built agent on one origin.
  if (process.env.NODE_ENV === "production") {
    return { kind: "same-origin", base: `http://127.0.0.1:${process.env.PORT ?? "3000"}` };
  }
  return null;
}

function eveMount(agentName: string): string {
  const target = eveTarget();
  if (!target) {
    throw new Error(
      "Eve is not reachable from this environment: set EVE_BASE_URL, start the eve dev server, or deploy where VERCEL_URL is set.",
    );
  }
  return target.kind === "standalone" ? `${target.base}/eve/v1` : `${target.base}/eve/${agentName}/v1`;
}

/**
 * The Eve session routes for one agent, plus the auth header to call them.
 *
 * The chat proxy needs the same mount resolution and the same short-lived
 * bridge token the driver mints, and duplicating either is how the app and the
 * agent drift apart. Keeping one resolver means a change to where Eve lives
 * cannot fix the driver and miss the stream.
 */
export function eveSessionEndpoint(input: {
  agentName?: string;
  sessionRef: string;
  auth: AuthContext;
  /** The absolute stream index to resume from; omitted reads from the start. */
  startIndex?: number;
  /** When true the response stops at the durable tail instead of following. */
  follow?: boolean;
}): { url: string; headers: Record<string, string> } {
  const mount = eveMount(input.agentName ?? "alfred");
  const params = new URLSearchParams();
  if (input.startIndex !== undefined) params.set("startIndex", String(input.startIndex));
  if (input.follow === false) params.set("follow", "false");
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return {
    url: `${mount}/session/${encodeURIComponent(input.sessionRef)}/stream${query}`,
    headers: { accept: "application/x-ndjson", ...bridgeHeaders(input.auth) },
  };
}

export function eveBridgeUnavailableReason(): string | null {
  if (!bridgeSecret()) {
    return "Agent execution is unavailable: EVE_BRIDGE_SECRET is not set (32 or more characters, the same value for the app and the Eve agent). No run was started.";
  }
  return null;
}

/** The Authorization header for one Eve call, minted from the caller's verified context. */
function bridgeHeaders(
  auth: AuthContext,
  claims: { runId?: string; skillId?: string } = {},
): Record<string, string> {
  const secret = bridgeSecret();
  if (!secret) throw new Error(eveBridgeUnavailableReason() ?? "Eve bridge is not configured.");
  const token = signBridgeToken(
    { userId: auth.userId, workspaceId: auth.workspaceId, role: auth.role, ...claims },
    { secret },
  );
  return { authorization: `Bearer ${token}` };
}

export function createEveDriver(agentName = "alfred"): SessionDriver {
  return {
    async start({ sessionId, objective, auth, instructions, policy }) {
      // The run id and the skill pin ride in the signed token rather than in a
      // row written after the session exists: the skill resolver runs at
      // session.started, before this driver could write session_ref, so a
      // lookup there would race the create call.
      const headers = bridgeHeaders(auth, {
        runId: sessionId,
        ...(policy.skill?.id ? { skillId: policy.skill.id } : {}),
      });
      const response = await fetch(`${eveMount(agentName)}/session`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          // The objective IS the first message: eve only starts a turn when
          // the create request carries one (message-free create parks the
          // session waiting for its first message, and no run would ever do
          // work).
          message: objective,
          // A specialist's role brief travels as eve client context, prepended
          // to the first turn. The REST surface has no per-session instructions
          // field, and resolving the brief from the run row inside the agent at
          // session.started would race this driver's session_ref write — the
          // brief arrives with the create call instead, so ordering is
          // guaranteed. The specialist agent's own instructions.md pins the
          // brief as the session's authoritative role.
          ...(instructions ? { context: [`axiom-specialist-brief v1\n${instructions}`] } : {}),
          // Create-once: a retried start of this run cannot fork a second session.
          operationId: `axiom-run-${sessionId}`,
        }),
      });
      if (!response.ok) {
        throw new Error(`eve session create failed: ${response.status} ${await response.text()}`);
      }
      const { sessionId: ref } = z.object({ sessionId: z.string().min(1) }).parse(await response.json());
      await db.update(agentRuns).set({ sessionRef: ref })
        .where(and(eq(agentRuns.id, sessionId), eq(agentRuns.workspaceId, auth.workspaceId)));
    },
    async signal(sessionId, signal, auth) {
      const [run] = await db
        .select({ sessionRef: agentRuns.sessionRef })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, sessionId), eq(agentRuns.workspaceId, auth.workspaceId)))
        .limit(1);
      const ref = run?.sessionRef;
      if (!ref) throw new Error("run has no Eve session yet");
      // "resume" carries no text to send; a follow-up is the message itself.
      if (signal === "resume") return;
      const response = await fetch(`${eveMount(agentName)}/session/${ref}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...bridgeHeaders(auth) },
        body: JSON.stringify({ message: signal }),
      });
      if (!response.ok) throw new Error(`eve follow-up failed: ${response.status}`);
    },
    async cancel(sessionId, auth) {
      const [run] = await db
        .select({ sessionRef: agentRuns.sessionRef })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, sessionId), eq(agentRuns.workspaceId, auth.workspaceId)))
        .limit(1);
      const ref = run?.sessionRef;
      if (!ref) return;
      let mount: string;
      try {
        mount = eveMount(agentName);
      } catch {
        return; // Nothing reachable to cancel against; the run row already records the stop.
      }
      await fetch(`${mount}/session/${ref}/cancel`, {
        method: "POST",
        headers: bridgeHeaders(auth),
      }).catch(() => undefined);
    },
  };
}

/*
 * Which eve agent serves a profile. Alfred keeps his own agent; every other
 * profile name (specialist:<slug>, specialist:custom:<name>) runs on the
 * shared specialist agent, which takes its role from the brief the driver
 * sends with the create call. This convention is the routing table — it needs
 * no column, and a profile cannot name itself onto the wrong agent because
 * "alfred" is only ever ensured by ensureProfile.
 */
export function eveAgentForProfile(profileName: string): string {
  return profileName === "alfred" ? "alfred" : "specialist";
}
