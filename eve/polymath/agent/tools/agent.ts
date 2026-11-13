// The built-in sub-agent tool, opted back in.
//
// Polymath runs with `defaultTools: false` (agent/agent.ts): the optional
// defaults include a shell and filesystem, which a server-side agent must not
// hold. That switch also removes `agent`, so the one default worth keeping is
// re-exported here. A call starts a copy of this agent in its own eve session
// (same instructions and gateway connection, empty history) and returns its
// reply as a task result. Only two lanes show it, and the copy works as the
// research or the deep-library sub-agent (src/domains/agents/lane-policy.ts).
export { default } from "eve/tools/agent";
