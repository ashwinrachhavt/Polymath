import { z } from "zod";
import { problemResponse } from "@/lib/problems";
import { getRunForGateway } from "@/domains/agents/queries";
import { gatewaySecret, verifyGatewayToken } from "@/domains/agents/gateway-token";
import { activeMembershipRole } from "@/domains/identity/resolve";
import { toolManifest } from "@/domains/integrations/tool-manifest";

/*
 * POST /api/mcp — the provider gateway eve reaches. JSON-RPC 2.0 over a single
 * stateless request/response; there is no session id and no SSE in this slice,
 * because three methods do not need a state machine and a session store would
 * be state that outlives the authorization it was granted under.
 *
 * Every call, including `initialize`, runs the bindings below in order before
 * dispatch. Each one re-reads the database: the token says who and which run,
 * but only the database says whether that run is still running and whether the
 * caller is still a member. A cached verdict would outlive a cancellation.
 *
 * Order matters. Authentication comes first so a stranger learns nothing;
 * tenancy before ownership so a foreign run and a missing run are the same 404
 * (the difference is not the caller's to learn); state last, so an unauthorized
 * caller never learns whether a run is running.
 */

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = "0.1.0";

type JsonRpcId = string | number | null;

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string(),
  params: z.unknown().optional(),
});

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

/** JSON-RPC errors travel inside a 200 body; the HTTP status stays for transport failures only. */
function rpcError(id: JsonRpcId, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

/** The bearer token, or null when the header is missing or malformed. */
function bearer(request: Request): string | null {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}

export async function POST(request: Request) {
  // 1. Token.
  const secret = gatewaySecret();
  // An unset secret is a deployment error, not a caller error: 503 tells the
  // operator, and it reveals nothing a scanner could use.
  if (!secret) return problemResponse(503, "gateway_unavailable", "The provider gateway is not configured.");
  const token = bearer(request);
  if (!token) return problemResponse(401, "unauthorized", "Unauthorized.");
  const claims = verifyGatewayToken(token, { secret });
  if (!claims) return problemResponse(401, "unauthorized", "Unauthorized.");

  // 2. Membership, re-proved rather than trusted from the claim.
  if (!(await activeMembershipRole(claims.workspaceId, claims.userId))) {
    return problemResponse(401, "unauthorized", "Unauthorized.");
  }

  // 3. The run named by the token, scoped to the token's workspace.
  const run = await getRunForGateway(claims.runId, claims.workspaceId);
  if (!run) return problemResponse(404, "not_found", "No such run.");

  // 4. Owner. Every run is personal today; the snapshot flag is read so a
  // workspace-shared profile can be added without reopening this file.
  const shared = (run.policySnapshot as { shared?: unknown } | null)?.shared === true;
  if (!shared && run.createdBy !== claims.userId) {
    return problemResponse(403, "forbidden", "This run is not yours to drive.");
  }

  // 5. State. A finished run keeps its token until expiry; it must not act.
  if (run.state !== "running") {
    return problemResponse(409, "run_not_running", "This run is not running.");
  }

  // 6. Session binding, when eve names one. A token already names the run, so
  // this catches a driver pointed at the wrong session before it acts.
  const sessionRef = request.headers.get("x-polymath-session");
  if (sessionRef !== null && sessionRef !== run.sessionRef) {
    return problemResponse(403, "forbidden", "This session is not bound to this run.");
  }

  const raw = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return rpcError(null, -32600, "Invalid Request.");
  const { id = null, method } = parsed.data;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "polymath-gateway", version: SERVER_VERSION },
      });
    case "notifications/initialized":
      return new Response(null, { status: 204 });
    case "tools/list":
      return rpcResult(id, { tools: toolManifest() });
    case "tools/call":
      // Dispatch lands in Task 6. Until then the call is refused rather than
      // silently dropped, so a client sees a method it cannot use.
      return rpcError(id, -32601, "tools/call is not implemented yet.");
    default:
      return rpcError(id, -32601, "Method not found.");
  }
}

/** Never cached: every response is a fresh authorization decision. */
export const dynamic = "force-dynamic";
