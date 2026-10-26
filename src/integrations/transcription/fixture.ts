import type { TranscriptionProvider } from "./provider";

/*
 * The e2e/integration fixture (TRANSCRIPTION_PROVIDER=fixture): one
 * deterministic transcript, free and local, selectable only by the explicit
 * env choice. Journeys can then walk voice capture -> transcript -> proposals
 * without a model key or a cent of spend. Production never sees it: nothing
 * selects it there, and the words it returns are unmistakably a fixture.
 */
export const FIXTURE_TRANSCRIPT =
  "Fixture transcript: send the Q3 roadmap to Priya by Friday and confirm the launch date.";

export function fixtureTranscriptionProvider(): TranscriptionProvider {
  return {
    name: "fixture:transcription",
    registryId: "fixture",
    async transcribe() {
      return { text: FIXTURE_TRANSCRIPT };
    },
  };
}
