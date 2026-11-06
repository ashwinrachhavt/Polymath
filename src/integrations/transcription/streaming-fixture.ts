import type { StreamingSessionEvents, StreamingTranscriptionProvider } from "./streaming";

/*
 * The dictation fixture (TRANSCRIPTION_STREAMING_PROVIDER=fixture): a
 * scripted interim -> final sequence, free and local, selectable only by the
 * explicit env choice - the same rule as the prerecorded fixture. Tests and
 * browser journeys can then walk mic -> interim -> final -> insertion
 * without a provider key or a cent of spend, and no deployment drifts into
 * invented transcripts: production never selects this.
 */
export const FIXTURE_STREAMING_SEGMENTS = [
  { interim: "Fixture dict", final: "Fixture dictation:" },
  { interim: "review the launch", final: "review the launch notes" },
] as const;

export function fixtureStreamingTranscriptionProvider(): StreamingTranscriptionProvider {
  return {
    name: "fixture:streaming-transcription",
    registryId: "fixture",
    async startSession(events: StreamingSessionEvents) {
      let cancelled = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      let at = 0;
      for (const segment of FIXTURE_STREAMING_SEGMENTS) {
        timers.push(
          setTimeout(() => {
            if (!cancelled) events.onInterim?.(segment.interim);
          }, at),
        );
        at += 5;
        timers.push(
          setTimeout(() => {
            if (!cancelled) events.onFinal?.({ text: segment.final, trailing: false });
          }, at),
        );
        at += 5;
      }
      return {
        stop() {
          for (const timer of timers) clearTimeout(timer);
          if (!cancelled) events.onFinal?.({ text: "", trailing: true });
          return Promise.resolve();
        },
        cancel() {
          cancelled = true;
          for (const timer of timers) clearTimeout(timer);
        },
      };
    },
  };
}
