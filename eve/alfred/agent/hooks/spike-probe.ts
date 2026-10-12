// Spike hook: proves `defineHook` + the `events` map actually fire. Throwaway.
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "session.started"(event, ctx) {
      console.info("spike hook: session.started", {
        type: event.type,
        sessionId: ctx.session.id,
        agent: ctx.agent.name,
        channelKind: ctx.channel.kind,
        principalType: ctx.session.auth.current?.principalType ?? null,
        principalId: ctx.session.auth.current?.principalId ?? null,
      });
    },
    async "turn.completed"(_event, ctx) {
      console.info("spike hook: turn.completed", { sessionId: ctx.session.id });
    },
  },
});
