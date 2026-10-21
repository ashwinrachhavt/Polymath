import { defineDynamic, defineSkill, type DynamicResolveContext } from "eve/skills";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { loadPinnedSkill } from "../../../../src/domains/skills/queries";

/*
 * The installed skill a run is pinned to, served from Postgres.
 *
 * The id arrives in the signed bridge token (channels/eve.ts), not from a row
 * the driver writes after creating the session. The resolver runs at
 * session.started, which is before that write could have landed, so reading
 * the pin from the token is what makes this race-free — and the signature is
 * what makes it trustworthy.
 *
 * The pin is the run's, frozen at start: editing or disabling the skill later
 * does not change what this session was told. loadPinnedSkill deliberately
 * does not filter on `enabled` for the same reason.
 *
 * This adds instructions only. It cannot widen the run's tools; those stay
 * bounded by the frozen policy snapshot and checked in lib/policy.ts.
 */

/**
 * The session's pin, from the auth of the caller who CREATED it.
 *
 * `current` is the caller of the active inbound turn, so a follow-up — or a
 * replayed session.started during recovery — carries a different (or claim-less)
 * token than the create call did. Reading `current` would drop the pin midway
 * through a session. `initiator` is the creator and does not move; fall back to
 * `current` only when eve has no initiator snapshot at all.
 */
function pinnedAttributes(ctx: Pick<DynamicResolveContext, "session">): Readonly<Record<string, string | readonly string[]>> | null {
  return ctx.session.auth.initiator?.attributes ?? ctx.session.auth.current?.attributes ?? null;
}

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const attrs = pinnedAttributes(ctx);
      const skillId = attrs?.skillId;
      const workspaceId = attrs?.workspaceId;
      const runId = attrs?.runId;
      // Non-string attributes cannot name a skill; treat them as no pin rather
      // than coercing a value the resolver never signed.
      if (typeof skillId !== "string" || typeof workspaceId !== "string") {
        // A known run with no resolvable pin is a broken binding, not a session
        // that never had one: say so, or the skill vanishes with no trace.
        if (typeof runId === "string") {
          console.warn(`skills: run ${runId} is pinned but its token carries no usable skillId; serving no skill`);
        }
        return null;
      }
      try {
        const skill = await loadPinnedSkill(workspaceId, skillId);
        if (!skill) {
          console.warn(`skills: run ${String(runId ?? "unknown")} pinned skill ${skillId}, which did not resolve in ${workspaceId}; serving no skill`);
          return null;
        }
        return defineSkill({
          description: skill.description,
          markdown: skill.body,
          // Stored as [{ path, text }]; eve wants a path-keyed record. Keys are
          // package-relative by construction at import time.
          files: Object.fromEntries(skill.files.map((file) => [file.path, file.text])),
        });
      } catch (cause) {
        // A database outage, or jsonb that is not the shape the schema promises,
        // must cost the skill, not the session: the run still has its tools.
        console.warn(`skills: resolving pinned skill ${skillId} failed; serving no skill`, cause);
        return null;
      }
    },
  },
});
