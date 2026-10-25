import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
import { withTransaction } from "../../../../src/lib/db-transaction";
import { createProposal } from "../../../../src/domains/actions/commands";
import { actionRevisions } from "../../../../src/domains/actions/schema";
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";

/*
 * An external-write capability. The handler does the one thing a consequential
 * action is allowed to do under Polymath policy: it writes an action_proposals row
 * with a preview and a dedupe key. It never calls Gmail — the send happens
 * later, from the approved attempt, outside this process. A model instruction
 * cannot escalate past that: there is no provider client here to call.
 *
 * No eve approval gate: the proposal IS the human gate. Gating twice would ask
 * the owner to approve a draft of an approval.
 */
export default defineTool({
  description:
    "Propose sending an email. Use only when the brief explicitly asks for an outbound message; research-only briefs never need it. It will not send — the owner approves or rejects in Reviews, and nothing leaves their account without that approval. Report a policy refusal as-is rather than rewording and retrying.",
  inputSchema: z.object({
    to: z.string().describe("Recipient address"),
    subject: z.string(),
    body: z.string(),
    messageId: z.string().describe("Provider message id this replies to, for dedupe"),
    accountAlias: z.string().optional().describe("Which connected Gmail account, e.g. work-gmail"),
  }),
  async execute(input, ctx) {
    const workspaceId = ctx.session.auth.current?.attributes?.workspaceId;
    const userId = ctx.session.auth.current?.principalId;
    if (typeof workspaceId !== "string") return { ok: false as const, error: "no workspace in session" };
    if (typeof userId !== "string") return { ok: false as const, error: "no user in session" };

    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, "gmail.send")) {
      return { ok: false as const, error: "gmail.send is not in this run's policy snapshot" };
    }

    // Deterministic from the intent: a resumed step or a retry re-derives the
    // same key and resolves the existing proposal rather than a second send.
    const dedupeKey = `gmail.send:${workspaceId}:${input.messageId}`;

    const result = await withTransaction(async (tx) => {
      const proposal = await createProposal(
        tx,
        { workspaceId },
        {
          capability: "gmail.send",
          riskClass: "external_write",
          targetType: "message",
          accountAlias: input.accountAlias,
          title: `Send "${input.subject}"`,
          expectedEffect: `Sends an email to ${input.to} from ${input.accountAlias ?? "the default account"}`,
          dedupeKey,
          runId: run.id,
          // An external write the owner has not decided on inside a day is stale.
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        },
      );
      // Without revision 1 the proposal cannot be decided at all: decideProposal
      // reads the newest revision and throws ProposalNotFoundError when there is
      // none. A replayed intent already has one, and appending a second would ask
      // the owner to approve the same intent twice.
      if (!proposal.deduplicated) {
        await tx.insert(actionRevisions).values({
          workspaceId,
          proposalId: proposal.proposalId,
          revisionNumber: 1,
          payload: { to: input.to, subject: input.subject, body: input.body, inReplyTo: input.messageId, accountAlias: input.accountAlias },
          preview: { to: input.to, subject: input.subject, body: input.body },
          createdBy: userId,
        });
      }
      return proposal;
    });

    return { ok: true as const, proposalId: result.proposalId, deduplicated: result.deduplicated, status: "awaiting review" };
  },
});
