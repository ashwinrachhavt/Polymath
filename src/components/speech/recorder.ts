/*
 * Microphone to clips. Each clip is a complete, independently decodable file:
 * MediaRecorder timeslice chunks are not (only the first carries the header),
 * so a long session rotates by starting a fresh recorder on the same stream
 * and stopping the old one. Every clip stays well under the route's 4 MB
 * ceiling: 2 minutes at 64 kbps is under 1 MB.
 */

const CLIP_MAX_MS = 2 * 60_000;
const AUDIO_BITS_PER_SECOND = 64_000;

type RecorderFailure = "permission" | "no-microphone" | "unsupported";

export type Recorder = {
  /** Finish: the last clip arrives through onClip with final = true, then the microphone is released. */
  stop(): void;
  /** Release the microphone now; no further clips are delivered. */
  discard(): void;
};

type Callbacks = {
  /** The microphone is open and audio is being captured. */
  onStart(): void;
  /** `audio` is null when nothing was captured, e.g. a stop before the microphone opened. */
  onClip(audio: Blob | null, final: boolean): void;
  onError(reason: RecorderFailure): void;
};

// Opus in WebM where supported; Safari records MP4 (AAC) instead.
function pickMimeType(): string {
  return (
    ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type)) ?? ""
  );
}

export function startRecorder(callbacks: Callbacks): Recorder {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    queueMicrotask(() => callbacks.onError("unsupported"));
    return { stop() {}, discard() {} };
  }

  let stream: MediaStream | null = null;
  let current: MediaRecorder | null = null;
  let rotation: ReturnType<typeof setTimeout> | undefined;
  let ending = false;
  let discarded = false;
  const mimeType = pickMimeType();

  const release = () => {
    clearTimeout(rotation);
    stream?.getTracks().forEach((track) => track.stop());
  };

  const record = () => {
    const recorder = new MediaRecorder(stream!, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      if (discarded) return;
      // A recorder also stops on its own when the device goes away.
      const final = recorder === current && (ending || stream!.getAudioTracks().every((t) => t.readyState === "ended"));
      if (final) release();
      const audio =
        chunks.length > 0 ? new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }) : null;
      callbacks.onClip(audio, final);
    };
    recorder.start();
    current = recorder;
    rotation = setTimeout(() => {
      // Start the next recorder before stopping this one, so no audio falls in the gap.
      const previous = recorder;
      record();
      previous.stop();
    }, CLIP_MAX_MS);
  };

  navigator.mediaDevices.getUserMedia({ audio: true }).then(
    (opened) => {
      stream = opened;
      if (discarded) return release();
      if (ending) {
        release();
        return callbacks.onClip(null, true);
      }
      record();
      callbacks.onStart();
    },
    (cause: unknown) => {
      if (discarded) return;
      const name = cause instanceof DOMException ? cause.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") return callbacks.onError("permission");
      if (name === "NotFoundError" || name === "OverconstrainedError") return callbacks.onError("no-microphone");
      callbacks.onError("unsupported");
    },
  );

  return {
    stop() {
      if (ending) return;
      ending = true;
      clearTimeout(rotation);
      if (current && current.state !== "inactive") current.stop();
    },
    discard() {
      discarded = true;
      ending = true;
      if (current && current.state !== "inactive") current.stop();
      release();
    },
  };
}
