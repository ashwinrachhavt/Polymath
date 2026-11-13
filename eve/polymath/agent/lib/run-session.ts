/*
 * The session a Polymath run is bound to. A sub-agent (a copy started through
 * the `agent` tool) runs in its own eve session, but it works for the root
 * session's run: its tool calls are authorized against that run's frozen
 * policy, and its spend and tool calls are recorded there.
 *
 * Only tools, the gateway connection and the usage/tool-call hooks use this.
 * Messages and turn lifecycle stay keyed to the session itself, so a copy's
 * reply to its parent never lands in the person's thread.
 */
export function runSessionRef(session: { id: string; parent?: { rootSessionId: string } }): string {
  return session.parent?.rootSessionId ?? session.id;
}
