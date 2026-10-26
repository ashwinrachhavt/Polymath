import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { proposeContactsFromSenders } from "../../../../src/domains/crm/propose-from-senders";

/*
 * Turns email senders the run just read into reviewable CRM proposals. Call it
 * with the messages from gmail_search; senders already in the CRM, the
 * owner's own addresses and automated senders are skipped for you. Nothing is
 * created until the owner approves each proposal in the review queue.
 */
export default defineTool({
  description:
    "Propose CRM contacts (and their company) for people who emailed the owner and are not in the CRM yet. Pass the messages you read with gmail_search: message id, thread id, From header, subject, date. Each new human sender becomes one proposal in the review queue linking the email thread; nothing is created until the owner approves it. Automated senders, the owner's own addresses and existing contacts are skipped and reported back.",
  inputSchema: z.object({
    messages: z
      .array(
        z.object({
          messageId: z.string().min(1).max(200),
          threadId: z.string().min(1).max(200),
          from: z.string().max(500).nullable(),
          subject: z.string().max(1000).nullable().optional(),
          date: z.string().max(100).nullable().optional(),
        }),
      )
      .min(1)
      .max(50),
    ownAddresses: z.array(z.string().max(320)).max(10).describe("The owner's own email addresses, so mail from them is never proposed as a contact."),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }
    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, "crm.contact.create")) {
      return { ok: false as const, error: "crm.contact.create is not in this run's policy snapshot" };
    }
    const result = await proposeContactsFromSenders(
      { userId: current.principalId, workspaceId },
      { messages: input.messages, ownAddresses: input.ownAddresses, runId: run.id },
    );
    return { ok: true as const, ...result, status: "awaiting review" };
  },
});
