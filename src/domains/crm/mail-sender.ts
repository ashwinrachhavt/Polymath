import {
  GmailSendAmbiguousError,
  sendGmailMessage,
} from "@/domains/integrations/gmail/send";
import {
  SendOutcomeUnknownError,
  SenderNotConfiguredError,
  type MailSender,
} from "./send-executor";

/*
 * The live MailSender: Gmail through Composio, over the connected account the
 * send executor already resolved and checked. Polymath stores the Composio
 * connected-account id, never an OAuth token.
 *
 * The port's one-wrong-move case is a send whose outcome is not provable. A
 * rejection (a documented pre-dispatch refusal, or the provider's own 4xx
 * inside the proxy envelope) is a safe failure and passes through with its
 * code. Anything ambiguous (timeout, 5xx, an answer without a message id)
 * becomes SendOutcomeUnknownError, which the executor settles as `unknown`
 * and blocks retry until a person reconciles it. Misconfiguration is reported
 * before the provider is touched, so a deployment without the key fails the
 * send honestly instead of recording a provider failure it never saw.
 */
export function gmailMailSender(env: Record<string, string | undefined> = process.env): MailSender {
  return {
    async send(input) {
      if (!env.COMPOSIO_API_KEY) {
        throw new SenderNotConfiguredError("COMPOSIO_API_KEY is not set on this deployment.");
      }
      try {
        const result = await sendGmailMessage({
          connectedAccountId: input.providerConnectedAccountId,
          to: input.to,
          subject: input.subject,
          body: input.body,
          attemptId: input.idempotencyKey,
        });
        return { providerObjectId: result.providerObjectId, threadId: result.threadId ?? undefined };
      } catch (error) {
        if (error instanceof GmailSendAmbiguousError) {
          throw new SendOutcomeUnknownError(error.message);
        }
        throw error;
      }
    },
  };
}
