import { defineDynamic, defineSkill } from "eve/skills";
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
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const attrs = ctx.session.auth.current?.attributes;
      const skillId = attrs?.skillId;
      const workspaceId = attrs?.workspaceId;
      // Non-string attributes cannot name a skill; treat them as no pin rather
      // than coercing a value the resolver never signed.
      if (typeof skillId !== "string" || typeof workspaceId !== "string") return null;
      const skill = await loadPinnedSkill(workspaceId, skillId);
      if (!skill) return null;
      return defineSkill({
        description: skill.description,
        markdown: skill.body,
        // Stored as [{ path, text }]; eve wants a path-keyed record. Keys are
        // package-relative by construction at import time.
        files: Object.fromEntries(skill.files.map((file) => [file.path, file.text])),
      });
    },
  },
});
