// The Eve channel's front door. A caller proves who it is with a short-lived
// signed bridge token (src/domains/agents/bridge-token.ts) minted by the app
// after Clerk has authenticated the user. The AuthFn verifies the signature,
// then re-checks the membership in the database, and only then puts the
// workspace id in the session attributes the event bridge and tools read.
// There is no asserted-identity header: a request without a valid token is
// anonymous and is refused.
import { type AuthFn, localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { bridgeSecret, verifyBridgeToken } from "../../../../src/domains/agents/bridge-token";
import { verifyWorkspaceBinding } from "../../../../src/domains/identity/resolve";

const bridgeAuth: AuthFn<Request> = async (request) => {
  const secret = bridgeSecret();
  if (!secret) return null;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const claims = verifyBridgeToken(header.slice("Bearer ".length).trim(), { secret });
  if (!claims) return null;
  const auth = await verifyWorkspaceBinding(claims);
  if (!auth) return null;
  return {
    // The claims ride the same signed token as the workspace, and the agent's
    // dynamic model handler reads the frozen model from here (step.started):
    // without it the specialist fell back to Gemini while the run row priced
    // mercury-3 — the run row and the answering model disagreed.
    attributes: {
      workspaceId: auth.workspaceId,
      ...(claims.runId !== undefined ? { runId: claims.runId } : {}),
      ...(claims.skillId !== undefined ? { skillId: claims.skillId } : {}),
      ...(claims.model !== undefined ? { model: claims.model } : {}),
    },
    authenticator: "axiom-bridge",
    principalId: auth.userId,
    principalType: "user",
  };
};

// localDev() is the Eve TUI's own loopback identity; it never carries a
// workspace, so it cannot start an Polymath run, and it is never mounted in production.
export default eveChannel({
  auth: [bridgeAuth, ...(process.env.NODE_ENV !== "production" ? [localDev()] : [])],
});
