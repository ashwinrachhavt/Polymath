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
    attributes: { workspaceId: auth.workspaceId },
    authenticator: "axiom-bridge",
    principalId: auth.userId,
    principalType: "user",
  };
};

// localDev() is the Eve TUI's own loopback identity; it never carries a
// workspace, so it cannot start an Polymath run, and it is never mounted in production.
//
// It is wrapped, not used directly, so the local eval runner can create stubbed
// sessions: eve denies tool replacement unless the verified auth result carries
// `allowToolStubs` (docs/guides/auth-and-route-protection, "Tool replacement
// permission"). The grant rides on this dev-only identity and nowhere else — the
// bridge token path above never sets it, so a real workspace caller cannot stub
// a tool in a deployed environment.
const localDevWithStubs: AuthFn<Request> = async (request) => {
  const caller = await localDev()(request);
  return caller ? { ...caller, allowToolStubs: true } : null;
};

export default eveChannel({
  auth: [bridgeAuth, ...(process.env.NODE_ENV !== "production" ? [localDevWithStubs] : [])],
});
