/*
 * The message a refusal to execute is allowed to show and persist. Provider
 * and policy errors are arbitrary text - the refusal note lives in the
 * review history long-term and the card renders it - so keep one bounded,
 * printable line rather than a raw provider body. The executor's own
 * refusals (the disabled-deployment refusal, an unpinned revision, account
 * drift) are already short single lines and pass through unchanged.
 */
export const REFUSAL_MESSAGE_MAX = 300;

export function refusalMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const printable = firstLine
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const message = printable || "The approved effect did not run.";
  return message.length > REFUSAL_MESSAGE_MAX
    ? message.slice(0, REFUSAL_MESSAGE_MAX)
    : message;
}
