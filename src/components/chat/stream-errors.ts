/*
 * What the owner reads when the chat stream cannot be opened. The raw
 * "stream returned 503" is a status line, not a state: each class of failure
 * names what happened and whether trying again can help.
 */

export class StreamHttpError extends Error {
  constructor(readonly status: number) {
    super(`stream returned ${status}`);
    this.name = "StreamHttpError";
  }
}

export type StreamFailure = {
  message: string;
  /** Whether reconnecting can ever help. Access and not-found failures cannot. */
  retryable: boolean;
};

export function describeStreamFailure(cause: unknown): StreamFailure {
  if (cause instanceof StreamHttpError) {
    const { status } = cause;
    if (status === 401 || status === 403) {
      return { message: "You no longer have access to this conversation. Sign in again.", retryable: false };
    }
    if (status === 404) return { message: "This conversation could not be found.", retryable: false };
    if (status === 429) return { message: "Too many requests. Waiting a moment before reconnecting.", retryable: true };
    if (status >= 500) return { message: "The assistant service is unavailable.", retryable: true };
    return { message: `The connection failed (${status}).`, retryable: true };
  }
  return { message: "The connection dropped.", retryable: true };
}
