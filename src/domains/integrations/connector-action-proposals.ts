import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { withTransaction } from "@/lib/db-transaction";
import { createProposal, decideProposalInTx, withSenderAccountPin } from "@/domains/actions/commands";
import { actionProposals, actionRevisions } from "@/domains/actions/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import {
  connectorActionArguments,
  connectorWrite,
  readConnectorAction,
  routineConnectorActionAllowed,
} from "./connector-actions";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

export async function proposeConnectorAction(input: {
  auth: AuthContext;
  runId: string;
  allowRoutine: boolean;
  capability: string;
  args: z.infer<typeof connectorActionArguments>;
  account: { alias: string; externalAccountId: string; connectedAccountId: string; displayName: string | null };
}) {
  const spec = connectorWrite(input.capability);
  if (!spec) throw new Error("Unsupported connector action.");
  const action = await readConnectorAction(spec.toolkit, input.args.toolSlug);
  const validation = z
    .fromJSONSchema({ ...action.input_parameters, additionalProperties: false })
    .safeParse(input.args.arguments);
  if (!validation.success)
    throw new Error(`Invalid connector arguments: ${validation.error.issues[0]?.message ?? "check the action schema"}`);
  const arguments_ = z.record(z.string(), z.unknown()).parse(validation.data);
  const payload = {
    toolSlug: action.slug,
    version: action.version,
    arguments: arguments_,
    summary: input.args.summary,
  };
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          accountId: input.account.externalAccountId,
          capability: input.capability,
          toolSlug: payload.toolSlug,
          arguments: payload.arguments,
        }),
      ),
    )
    .digest("hex");
  const routine =
    input.allowRoutine &&
    input.auth.role === "owner" &&
    (await routineConnectorActionAllowed(action.slug, arguments_, input.account.connectedAccountId));
  return withTransaction(async (tx) => {
    const proposal = await createProposal(
      tx,
      { workspaceId: input.auth.workspaceId },
      {
        capability: input.capability,
        riskClass: "external_write",
        accountAlias: input.account.alias,
        title: input.args.summary,
        expectedEffect: `Runs ${action.name} in ${input.account.alias} with the exact arguments shown.`,
        dedupeKey: `connector:${input.runId}:${hash}`,
        runId: input.runId,
        expiresAt: new Date(Date.now() + 86400000),
      },
    );
    if (!proposal.deduplicated) {
      const pinned = withSenderAccountPin(
        {
          resolved: true,
          externalAccountId: input.account.externalAccountId,
          connectedAccountId: input.account.connectedAccountId,
          alias: input.account.alias,
          sender: input.account.displayName ?? input.account.alias,
        },
        payload,
        payload,
      );
      await tx.insert(actionRevisions).values({
        workspaceId: input.auth.workspaceId,
        proposalId: proposal.proposalId,
        revisionNumber: 1,
        payload: pinned.payload,
        preview: pinned.preview,
        createdBy: input.auth.userId,
      });
    }
    const [row] = await tx
      .select({ version: actionProposals.version, status: actionProposals.status })
      .from(actionProposals)
      .where(and(eq(actionProposals.id, proposal.proposalId), eq(actionProposals.workspaceId, input.auth.workspaceId)))
      .limit(1);
    if (routine && !proposal.deduplicated && row?.status === "pending") {
      const [revision] = await tx
        .select({ id: actionRevisions.id })
        .from(actionRevisions)
        .where(eq(actionRevisions.proposalId, proposal.proposalId))
        .orderBy(desc(actionRevisions.revisionNumber))
        .limit(1);
      if (!revision) throw new Error("The routine action has no bound revision.");
      await decideProposalInTx(tx, input.auth, {
        proposalId: proposal.proposalId,
        expectedVersion: row.version,
        revisionId: revision.id,
        decision: "approved",
        note: "Automatic routine action authorized by connector Write access.",
        idempotencyKey: `routine:${proposal.proposalId}:${revision.id}`,
      });
      return { ...proposal, execution: "direct" as const, proposalStatus: "approved" as const };
    }
    if (!row) throw new Error("The connector action disappeared before it could be read.");
    return {
      ...proposal,
      proposalStatus: row.status,
      execution: routine && row.status === "approved" ? ("direct" as const) : ("review" as const),
    };
  });
}
