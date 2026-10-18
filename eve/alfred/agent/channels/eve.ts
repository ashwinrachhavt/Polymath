// Spike channel: proves a custom AuthFn can resolve an arbitrary inbound
// credential (here: a stand-in for Axiom's Clerk session) instead of only
// Vercel OIDC. The AuthFn resolves the caller's real Axiom identity through
// the same path the app's route handlers use, so the workspace id that lands
// in session attributes is a real uuid the event bridge can query by.
// Throwaway.
import { type AuthFn, localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { resolveAuthContext } from "../../../../src/domains/identity/resolve";
import { clerkConfigured } from "../../../../src/lib/clerk";

const developmentOnly = process.env.NODE_ENV !== "production" && !clerkConfigured;

const clerkSessionStub: AuthFn<Request> = async (request) => {
  // An asserted user id is not authentication. Keep the throwaway spike closed
  // whenever real Clerk identity is configured, including configured dev apps.
  if (!developmentOnly) return null;
  const userId = request.headers.get("x-spike-clerk-user-id");
  if (userId !== "dev-user") return null;
  const auth = await resolveAuthContext(userId);
  return {
    attributes: { workspaceId: auth.workspaceId },
    authenticator: "clerk",
    principalId: auth.userId,
    principalType: "user",
  };
};

export default eveChannel({
  auth: [clerkSessionStub, ...(developmentOnly ? [localDev()] : [])],
});
