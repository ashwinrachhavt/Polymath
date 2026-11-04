// The built-in subagent tool, opted back in.
//
// Polymath runs with `defaultTools: false` (agent/agent.ts): the optional
// defaults include a shell and filesystem, which a chief-of-staff agent must
// not hold. That switch also removes `agent`, so the one default worth keeping
// is re-exported here. A call starts a fresh copy of this agent — same
// instructions, tools and gateway connection, empty history — and returns its
// reply as a task result. Use it for independent parallel work, never to dodge
// a decision (see the <delegation> block in instructions.md).
export { default } from "eve/tools/agent";
