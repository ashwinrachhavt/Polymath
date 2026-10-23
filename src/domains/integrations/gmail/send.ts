import { executeComposioWrite } from "../composio";

/*
 * The one provider write this codebase can perform. Only the two
 * approval-bound executors call it: the approved-effect executor for
 * agent-run proposals, and the CRM send executor through the MailSender
 * adapter in `src/domains/crm/mail-sender.ts`. No tool, no gateway path, no
 * route.
 *
 * The Message-ID is derived from the attempt id rather than stored. That gives
 * reconciliation a stable way to ask Gmail "did this land?" without a second
 * column that could disagree with the attempt, and it means a crash before the
 * settle still leaves a searchable marker in the sent message.
 *
 * Failure classification is the whole safety story, grounded in two
 * contracts (Composio proxy reference, fetched 2026-10-23; the Gmail
 * messages.send API, which returns errors without creating a message):
 *  - the proxy's own non-200 4xx is a documented pre-dispatch refusal (bad
 *    key, unknown account, invalid proxy request, rate limit) -> rejected;
 *  - a provider 4xx arrives inside the proxy's 200 envelope (`status`) and
 *    means Gmail refused before creating anything -> rejected;
 *  - a timeout, any 5xx, or a success we cannot prove (no message id, no
 *    trustworthy envelope) proves nothing -> ambiguous.
 * The executor maps ambiguous to UNKNOWN, which blocks retry until reconciled.
 * A rejected send carries only the status number - never the provider's
 * error body, which can echo the request back.
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
    // The proxy's own documented 4xx refused the call before dispatch; the
    // provider was never reached. Everything else proves nothing.
    if (result.code === "provider_error" && typeof result.status === "number" && result.status >= 400 && result.status < 500) {
      throw new GmailSendRejectedError(result.status);
    }
    // not_configured, ambiguous, or a 5xx: nothing proves the message did not
    // leave, so the caller must not treat this as a failure it can retry.
    throw new GmailSendAmbiguousError(result.message);
  }

  // The proxy answered 200, which only means the envelope arrived - the
  // provider's own status rides inside it. A provider 4xx is a refusal
  // before Gmail created anything; a provider 5xx proves nothing.
  if (typeof result.providerStatus === "number") {
    if (result.providerStatus >= 400 && result.providerStatus < 500) {
      throw new GmailSendRejectedError(result.providerStatus);
    }
    if (result.providerStatus >= 500) {
      throw new GmailSendAmbiguousError(`Gmail returned ${result.providerStatus}; the send outcome is unproven.`);
    }
  }

  const id = providerId(result.data);
  if (!id) throw new GmailSendAmbiguousError("Gmail answered without a message id.");
  const threadId =
    typeof (result.data as { threadId?: unknown }).threadId === "string"
      ? (result.data as { threadId: string }).threadId
      : null;
  return { providerObjectId: id, threadId };
}
