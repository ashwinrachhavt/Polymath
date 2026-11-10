/**
 * The conversation window's stage chip: one derivation for every place the
 * surface names the run's stage — the header when it renders, the quiet line
 * when it does not.
 *
 * The Reviews agent views is the honest surface: it classifies the run's own
 * report (`ticketStage`, docs/003) and speaks the stage table's words
 * (`STAGE_META`). The chip used to read the stream's transport state with a
 * private two-word vocabulary instead, so a failed run — its row failed while
 * the transport sat in connecting/streaming, or its end frame read as a plain
 * finish — showed "Working" or "Finished" beside a panel saying "Failed".
 * It now derives from the same facts the panel reads (the run's failed
 * report, carried live by the stream) and speaks the panel's word for them,
 * falling back to the transport state only while the run's stage is live.
 */
import { STAGE_META } from "@/components/superagent/view";
import type { ChatConnection } from "./use-chat-stream";

/** What the chip reads: the transport state plus the run-stage facts the stream carries. */
export type StageChipFacts = {
  connection: ChatConnection;
  /** The stream's end frame said the run failed — the panel's person-failed stage. */
  runFailed: boolean;
  /** The latest turn failed and the run waits for a person — also the panel's person-failed. */
  lastFailedTurn: boolean;
};

export type StageChipStatus = "failed" | "paused" | "working" | "waiting" | "finished" | "offline";

/**
 * The chip's status, failed first: a failed run or turn renders as failed
 * whatever the transport is doing — a reconnect that has not replayed the end
 * frame yet must never read as "Working". A reconnecting transport is the
 * second truth: a drop is a pause (the durable stream keeps the run's events),
 * so it renders pause vocabulary, never "Working" over a transport that is not
 * delivering and never "Failed" — only a real run failure pins that. A stream
 * that gave up without a terminal frame is the one state the chip does not
 * name: the run's stage is unknown rather than failed, and the transcript's
 * own alert carries the transport's error.
 */
export function stageChipStatus({ connection, runFailed, lastFailedTurn }: StageChipFacts): StageChipStatus {
  if (runFailed || lastFailedTurn) return "failed";
  switch (connection) {
    case "reconnecting":
      return "paused";
    case "connecting":
    case "streaming":
      return "working";
    case "waiting":
      return "waiting";
    case "done":
      return "finished";
    case "error":
      return "offline";
  }
}

/**
 * The chip's words. Failed and working speak the Reviews agent views's own
 * vocabulary (`STAGE_META`) — one definition, two surfaces. Paused names the
 * transport, not a run stage: the stage table has no row for a dropped
 * connection, and "Reconnecting…" is the honest word for one. Waiting and
 * finished keep the conversation's transport-honest phrasing, for which the
 * stage table has no row ("Idle"/"Ended" describe a ticket between turns, not
 * a conversation waiting for its next message). Null renders nothing — the
 * header's error state, as before.
 */
export function stageChipLabel(status: StageChipStatus): string | null {
  switch (status) {
    case "failed":
      return STAGE_META["person-failed"].label;
    case "paused":
      return "Reconnecting…";
    case "working":
      return STAGE_META.working.label;
    case "waiting":
      return "Waiting for a message";
    case "finished":
      return "Finished";
    case "offline":
      return null;
  }
}
