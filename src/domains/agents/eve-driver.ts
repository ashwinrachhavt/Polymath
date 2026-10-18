import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveAuthContext, type AuthContext } from "@/domains/identity/resolve";
import { clerkConfigured } from "@/lib/clerk";
import { db } from "@/lib/db";
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

function eveBaseUrl(): string {
  const url = process.env.EVE_BASE_URL;
  if (url && url.trim().length > 0) return url.replace(/\/+$/, "");
  // Dev: the eve dev server publishes its port here. Production rides the
  // withEve service on the same origin, so the default is the app itself.
  try {
    // ponytail: sync fs read at call time; fine at run-start frequency.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const state = require("fs").readFileSync(
      `${process.cwd()}/eve/alfred/.eve/dev-server-state.v1.json`,
      "utf8",
    ) as string;
    const parsed = JSON.parse(state) as { url?: string };
    if (parsed.url) return parsed.url.replace(/\/+$/, "");
  } catch {
    // Fall through to same-origin: correct for `next start` with a built agent.
  }
  return "";
}

export function eveBridgeUnavailableReason(): string | null {
  if (process.env.NODE_ENV === "production" || clerkConfigured) {
    return "Agent execution is unavailable: the Eve bridge does not yet support verified Clerk identity. No run was started.";
  }
  return null;
}

async function localOwner(): Promise<AuthContext> {
  const reason = eveBridgeUnavailableReason();
  if (reason) throw new Error(reason);
  return resolveAuthContext("dev-user");
}

export function createEveDriver(agentName = "alfred"): SessionDriver {
  return {
    async start({ sessionId, objective, auth }) {
      const owner = await localOwner();
      if (auth.userId !== owner.userId || auth.workspaceId !== owner.workspaceId || auth.role !== owner.role) {
        throw new Error("The development Eve bridge cannot execute for another identity.");
      }
      const base = eveBaseUrl();
      const mount = base ? `${base}/eve/v1` : `/eve/${agentName}/v1`;
      const response = await fetch(`${mount}/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Only the unconfigured local-development owner may use this spike.
          // This is not a Clerk credential and is never sent for real users.
          "x-spike-clerk-user-id": "dev-user",
        },
        body: JSON.stringify({
          // The objective IS the first message: eve only starts a turn when
          // the create request carries one (message-free create parks the
          // session waiting for its first message, and no run would ever do
          // work).
          message: objective,
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
    async signal() {
      // Resume and steer arrive with the real tool surfaces; nothing to send yet.
    },
    async cancel(sessionId) {
      const owner = await localOwner();
      const [run] = await db
        .select({ sessionRef: agentRuns.sessionRef })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, sessionId), eq(agentRuns.workspaceId, owner.workspaceId)))
        .limit(1);
      const ref = run?.sessionRef;
      if (!ref) return;
      const base = eveBaseUrl();
      const mount = base ? `${base}/eve/v1` : `/eve/${agentName}/v1`;
      await fetch(`${mount}/session/${ref}/cancel`, {
        method: "POST",
        headers: { "x-spike-clerk-user-id": "dev-user" },
      }).catch(() => undefined);
    },
  };
}
