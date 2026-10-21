import { ConnectionAuthorizationRequiredError, defineMcpClientConnection } from "eve/connections";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { gatewaySecret, signGatewayToken } from "../../../../src/domains/agents/gateway-token";
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";

/*
 * The one door to provider tools.
 *
 * The agent holds no provider credential. It asks the gateway, which re-reads
 * the run, the membership, and the frozen policy on every call, and turns a
 * write into a proposal instead of calling the provider. One place to audit,
 * one place to fix — the reason the URL proxy and the standalone gmail_send
 * tool are gone.
 *
 * Two secrets, deliberately: the bridge token (app to eve) proves who the
 * person is; this one proves eve is acting for one live run. A token minted
 * with the bridge secret cannot be used here, and vice versa.
 */

/** The app origin serving POST /api/mcp. Absolute, set per deployment. */
const GATEWAY_URL = `${(process.env.POLYMATH_GATEWAY_URL?.trim() || "http://127.0.0.1:3000").replace(/\/+$/, "")}/api/mcp`;

/** The connection slug, as eve derives it from this filename. */
const CONNECTION_NAME = "polymath_gateway";

export default defineMcpClientConnection({
  url: GATEWAY_URL,
  description:
    "Polymath provider gateway: Gmail search, thread read, and send proposals for the signed-in workspace.",
  auth: (ctx) => ({
    // The agent acts as the run, not as a person's stored credential. The
    // gateway still proves the run belongs to the signed-in user on each call.
    credentialOwner: "app",
    getToken: async () => {
      const current = ctx.session.auth.current;
      const workspaceId = current?.attributes?.workspaceId;
      if (typeof workspaceId !== "string" || !current?.principalId) {
        // Thrown rather than returning a token: an anonymous call would reach
        // the gateway and be refused there, which reads to the model as a
        // transient failure instead of the missing identity it is.
        throw new ConnectionAuthorizationRequiredError(CONNECTION_NAME, {
          message: "This session has no verified workspace, so the provider gateway cannot be called.",
        });
      }

      // The gateway authorizes a run, not a session. With no run there is
      // nothing to bind the call to, so this fails loudly.
      const run = await getRunBySessionRef(ctx.session.id, workspaceId);
      if (!run) {
        throw new ConnectionAuthorizationRequiredError(CONNECTION_NAME, {
          message: "No Polymath run is bound to this session, so the provider gateway cannot be called.",
        });
      }
      // A finished run is not a sign-in problem: telling the person to
      // authorize would send them to a flow that cannot help.
      if (run.state !== "running") {
        throw new Error(`The Polymath run for this session is ${run.state}, so the provider gateway cannot be called.`);
      }

      const secret = gatewaySecret();
      if (!secret) {
        // A deployment missing the secret is an operator error. Naming it here
        // beats surfacing the gateway's 503 as a tool failure.
        throw new Error("EVE_GATEWAY_SECRET is not set; the provider gateway token cannot be signed.");
      }

      return {
        token: signGatewayToken(
          { runId: run.id, userId: current.principalId, workspaceId },
          { secret },
        ),
        // The gateway checks the signature and the 60-second expiry itself.
        // This only stops eve from replaying one token across a long turn:
        // evicting it before the real expiry keeps the mint per call.
        expiresAt: Date.now() + 55_000,
      };
    },
  }),
  // The token is what authorizes; this header lets the gateway reject a driver
  // bound to the wrong session before it acts (route.ts step 6).
  headers: (ctx) => ({ "x-polymath-session": ctx.session.id }),
  // Only what this slice ships. The gateway refuses anything else, but the
  // model should not be shown names it can never call.
  tools: { allow: ["gmail_search", "gmail_read_thread", "gmail_send"] },
  // No connection-level approval: a send is a proposal the owner decides in
  // /reviews, and gating twice asks for approval of an approval.
});
