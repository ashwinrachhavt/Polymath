/*
 * Messages the owner has sent that the stream has not echoed yet.
 *
 * A pending message is shown the moment Send is pressed and dropped when the
 * server's own copy arrives. Matching on text alone would hide a second,
 * identical question behind the first one's echo, so each pending entry
 * remembers how many identical user messages the transcript already held when
 * it was sent: it is echoed only when the count rises above that baseline.
 */

export type PendingMessage = { id: string; text: string; baseline: number };

export function countUserMessages(userTexts: readonly string[], text: string): number {
  return userTexts.reduce((n, candidate) => (candidate === text ? n + 1 : n), 0);
}

export function makePending(id: string, text: string, userTexts: readonly string[]): PendingMessage {
  return { id, text, baseline: countUserMessages(userTexts, text) };
}

/**
 * The pending messages still waiting for an echo. Entries with the same text
 * are matched in send order, so two quick identical sends need two echoes.
 */
export function stillPending(pending: readonly PendingMessage[], userTexts: readonly string[]): PendingMessage[] {
  const consumed = new Map<string, number>();
  const result: PendingMessage[] = [];
  for (const entry of pending) {
    const echoes = countUserMessages(userTexts, entry.text) - entry.baseline;
    const used = consumed.get(entry.text) ?? 0;
    if (echoes > used) {
      consumed.set(entry.text, used + 1);
    } else {
      result.push(entry);
    }
  }
  return result;
}
