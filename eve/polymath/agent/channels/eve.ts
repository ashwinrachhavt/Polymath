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
    // The run and skill pin come from the same signed claims as the workspace,
    // so the skill resolver can read them at session.started without a
    // database write having landed first (see skills/polymath_skill.ts).
    attributes: {
      workspaceId: auth.workspaceId,
      ...(claims.runId !== undefined ? { runId: claims.runId } : {}),
      ...(claims.skillId !== undefined ? { skillId: claims.skillId } : {}),
      // The run's frozen model, so the agent runs the one the run row prices.
      ...(claims.model !== undefined ? { model: claims.model } : {}),
    },
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

// The authenticators, in order. `localDevWithStubs` is dev-only and never
// mounted in production; the bridge token path is the only production caller.
//
// Exported because the acceptance test needs to call one directly, and reading
// it back out of the channel object depends on a shape eve owns. Testing the
// array we build is testing the thing that decides who gets in.
export const authenticators: AuthFn<Request>[] = [bridgeAuth];
if (process.env.NODE_ENV !== "production") authenticators.push(localDevWithStubs);

export default eveChannel({ auth: authenticators });
