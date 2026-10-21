import { executeComposioWrite } from "../composio";

/*
 * The one provider write this codebase can perform. It is called by the
 * approved-effect executor and nowhere else: no tool, no gateway path, no
 * route.
 *
 * The Message-ID is derived from the attempt id rather than stored. That gives
 * reconciliation a stable way to ask Gmail "did this land?" without a second
 * column that could disagree with the attempt, and it means a crash before the
 * settle still leaves a searchable marker in the sent message.
 *
 * Failure classification is the whole safety story:
 *  - a 4xx is proof the message was refused before dispatch -> rejected;
 *  - a timeout, a 5xx, or a 2xx we cannot parse proves nothing -> ambiguous.
 * The executor maps ambiguous to UNKNOWN, which blocks retry until reconciled.
 */

const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export class GmailSendRejectedError extends Error {
  readonly code = "gmail_send_rejected";
  constructor(readonly status: number) {
    super(`Gmail rejected the send (${status}).`);
    this.name = "GmailSendRejectedError";
  }
}

export class GmailSendAmbiguousError extends Error {
  readonly code = "gmail_send_ambiguous";
  constructor(message: string) {
    super(message);
    this.name = "GmailSendAmbiguousError";
  }
}

export function messageIdMarker(attemptId: string): string {
  return `<polymath-${attemptId}@polymath.invalid>`;
}

/** RFC 2047 encoded-word, so a non-ASCII subject survives the header line. */
function encodeHeaderValue(value: string): string {
  // Plain ASCII stays readable; anything else is base64 encoded-word.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * RFC 2822, CRLF line endings, no display-name guessing: the From header is
 * left to the provider, which fills it from the sending account.
 */
export function buildRawMessage(input: {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  attemptId: string;
}): string {
  const header = (name: string, value: string) => (value === "" ? "" : `${name}: ${value}\r\n`);
  const lines = [
    header("To", input.to),
    header("Subject", encodeHeaderValue(input.subject)),
    header("Message-ID", messageIdMarker(input.attemptId)),
    header("In-Reply-To", input.inReplyTo ?? ""),
    header("References", input.inReplyTo ?? ""),
    "MIME-Version: 1.0\r\n",
    "Content-Type: text/plain; charset=UTF-8\r\n",
    "Content-Transfer-Encoding: 8bit\r\n",
    "\r\n",
    input.body,
  ];
  return lines.join("");
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function providerId(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function sendGmailMessage(input: {
  connectedAccountId: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  attemptId: string;
}): Promise<{ providerObjectId: string; threadId: string | null }> {
  const raw = base64Url(
    buildRawMessage({
      to: input.to,
      subject: input.subject,
      body: input.body,
      inReplyTo: input.inReplyTo,
      attemptId: input.attemptId,
    }),
  );
  const result = await executeComposioWrite({
    connectedAccountId: input.connectedAccountId,
    endpoint: SEND_ENDPOINT,
    method: "POST",
    body: { raw },
  });

  if (!result.ok) {
    if (result.code === "provider_error" && typeof result.status === "number" && result.status >= 400 && result.status < 500) {
      throw new GmailSendRejectedError(result.status);
    }
    // not_configured, ambiguous, or a 5xx: nothing proves the message did not
    // leave, so the caller must not treat this as a failure it can retry.
    throw new GmailSendAmbiguousError(result.message);
  }

  const id = providerId(result.data);
  if (!id) throw new GmailSendAmbiguousError("Gmail answered without a message id.");
  const threadId =
    typeof (result.data as { threadId?: unknown }).threadId === "string"
      ? (result.data as { threadId: string }).threadId
      : null;
  return { providerObjectId: id, threadId };
}
