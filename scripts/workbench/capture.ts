/*
 * Workbench checkpoint capture (D1). One command after an AI coding session
 * durably records WHAT changed in the repository, so an evidence-tiered
 * change brief can later be rendered from it:
 *
 *   pnpm workbench:capture --repo <path> --base <sha> [--run <runId>]
 *     [--workspace <id>] [--test-results <file>] [--decision "<note>"]
 *     [--decision-status recorded|inferred] [--apply]
 *
 * Dry-run by default; writes only with --apply. Mechanical only — git
 * status/diff/log plus the provided test-results file. No LLM call, no
 * network (the diff blob goes to the configured object store, local disk in
 * development), no hooks. Steps: verify capture point → store diff bytes in
 * audit.blob_objects (deduped by content_hash) → insert the repo_checkpoints
 * row → create the deterministic brief artifact and link it to the run
 * (artifact_links, target kind "run", reason "explains") → recordAudit
 * "workbench.checkpoint_captured". Append-only: re-running --apply writes a
 * second checkpoint row and reuses the blob; history is never rewritten.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { putBlob } from "@/integrations/object-store/object-store";
import { artifactLinks, artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { agentRuns, repoCheckpoints } from "@/domains/agents/schema";
import { memberships } from "@/domains/identity/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { recordAudit } from "@/domains/audit/record";
import { blobObjects } from "@/domains/audit/schema";
import { db } from "@/lib/db";
import type { TxDrizzle } from "@/lib/db-transaction";
import { withTransaction } from "@/lib/db-transaction";
import { buildCapturePlan, collectGitState, parseTestResults, CaptureError } from "./capture-core";
import type { CapturePlan } from "./capture-core";

export type CaptureResult = {
  checkpointId: string;
  artifactId: string;
  versionId: string;
  blobId: string;
  /** True when an identical diff already had a blob row and it was reused. */
  diffBlobDeduped: boolean;
  linkCreated: boolean;
};

/**
 * The write half, in one transaction: a checkpoint with no audit row did not
 * happen, and the artifact, its version and the run link must agree with it.
 * `putBlob` is a filesystem write and rides inside the window — a rolled-back
 * transaction can orphan the bytes, and an object with no row is garbage by
 * the blob ledger's rule, never a live reference.
 */
export async function captureToWorkspace(auth: AuthContext, plan: CapturePlan, tx: TxDrizzle): Promise<CaptureResult> {
  const [existingBlob] = await tx
    .select({ id: blobObjects.id })
    .from(blobObjects)
    .where(and(eq(blobObjects.workspaceId, auth.workspaceId), eq(blobObjects.contentHash, plan.diffHash)))
    .limit(1);

  let blobId: string;
  let diffBlobDeduped = false;
  if (existingBlob) {
    blobId = existingBlob.id;
    diffBlobDeduped = true;
  } else {
    const stored = await putBlob({
      bytes: plan.diffBytes,
      filename: `checkpoint-${plan.headSha.slice(0, 12)}.diff`,
      contentType: "text/x-diff; charset=utf-8",
      workspaceId: auth.workspaceId,
      contentHash: plan.diffHash,
    });
    const [blob] = await tx
      .insert(blobObjects)
      .values({
        workspaceId: auth.workspaceId,
        storageKey: stored.storageKey,
        contentHash: stored.contentHash,
        sizeBytes: stored.sizeBytes,
        mimeType: "text/x-diff",
      })
      .returning({ id: blobObjects.id });
    blobId = blob.id;
  }

  const [checkpoint] = await tx
    .insert(repoCheckpoints)
    .values({
      workspaceId: auth.workspaceId,
      runId: plan.runId,
      repoUrl: plan.repoUrl,
      baseCommitSha: plan.baseSha,
      commitSha: plan.headSha,
      diffBlobId: blobId,
      testResults: plan.testResults.length > 0 ? plan.testResults : null,
      decisionNote: plan.decisionNote,
      decisionStatus: plan.decisionStatus,
    })
    .returning({ id: repoCheckpoints.id });

  const [artifact] = await tx
    .insert(artifacts)
    .values({
      workspaceId: auth.workspaceId,
      kind: "report",
      title: plan.artifactTitle,
      status: "generated",
      producedByRunId: plan.runId,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning({ id: artifacts.id });
  const [version] = await tx
    .insert(artifactVersions)
    .values({
      workspaceId: auth.workspaceId,
      artifactId: artifact.id,
      versionNumber: 1,
      content: { text: plan.briefMarkdown },
      plainText: plan.briefMarkdown,
      reason: "generated",
      createdBy: auth.userId,
    })
    .returning({ id: artifactVersions.id });
  await tx.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));

  const linkCreated = plan.runId !== null;
  if (plan.runId) {
    await tx.insert(artifactLinks).values({
      workspaceId: auth.workspaceId,
      artifactId: artifact.id,
      targetType: "run",
      targetId: plan.runId,
      linkType: "explains",
      context: plan.linkContext,
    });
  }

  await recordAudit(
    auth,
    {
      action: "workbench.checkpoint_captured",
      subjectType: "repo_checkpoint",
      subjectId: checkpoint.id,
      summary: `Captured ${plan.changedPaths.length} changed path(s) at ${plan.headSha.slice(0, 12)} (${plan.decisionStatus})`,
      metadata: {
        runId: plan.runId,
        baseCommitSha: plan.baseSha,
        commitSha: plan.headSha,
        diffBlobId: blobId,
        artifactId: artifact.id,
        diffBlobDeduped,
      },
      actorKind: "system",
    },
    tx,
  );

  return { checkpointId: checkpoint.id, artifactId: artifact.id, versionId: version.id, blobId, diffBlobDeduped, linkCreated };
}

/** Resolve the workspace (from --run or --workspace) and the owning user for the audit trail. */
async function resolveContext(input: { runId: string | null; workspaceId: string | null }): Promise<AuthContext> {
  let workspaceId = input.workspaceId;
  if (input.runId) {
    const [run] = await db
      .select({ id: agentRuns.id, workspaceId: agentRuns.workspaceId })
      .from(agentRuns)
      .where(eq(agentRuns.id, input.runId))
      .limit(1);
    if (!run) throw new CaptureError("bad_base", `No agent run ${input.runId}`);
    if (workspaceId && workspaceId !== run.workspaceId) {
      throw new CaptureError("bad_base", `Run ${input.runId} belongs to workspace ${run.workspaceId}, not ${workspaceId}`);
    }
    workspaceId = run.workspaceId;
  }
  if (!workspaceId) throw new CaptureError("bad_base", "Pass --run <runId> or --workspace <workspaceId>");
  const [owner] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "owner"), eq(memberships.status, "active")))
    .limit(1);
  if (!owner) throw new CaptureError("bad_base", `Workspace ${workspaceId} has no active owner membership to attribute the capture to`);
  return { userId: owner.userId, workspaceId, role: "owner" };
}

type CaptureArgs = {
  repo: string;
  base: string;
  runId: string | null;
  workspaceId: string | null;
  testResultsPath: string | null;
  decisionNote: string | null;
  decisionStatus: "recorded" | "inferred";
  apply: boolean;
};

function parseArgs(argv: string[]): CaptureArgs {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const decisionStatus = get("--decision-status");
  return {
    repo: get("--repo") ?? process.cwd(),
    base: get("--base") ?? "",
    runId: get("--run") ?? null,
    workspaceId: get("--workspace") ?? null,
    testResultsPath: get("--test-results") ?? null,
    decisionNote: get("--decision") ?? null,
    decisionStatus: decisionStatus === "recorded" ? "recorded" : "inferred",
    apply: argv.includes("--apply"),
  };
}

async function runCapture(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args.base) throw new CaptureError("bad_base", "Pass --base <sha> (the commit the session started from)");
  const state = await collectGitState({ repoPath: args.repo, baseSha: args.base });
  const testResults = args.testResultsPath ? parseTestResults(readFileSync(args.testResultsPath, "utf8"), new Date().toISOString()) : [];

  if (!args.apply) {
    const plan = await buildCapturePlan({
      state,
      workspaceId: args.workspaceId ?? "<unresolved — pass --workspace or --run>",
      runId: args.runId,
      testResults,
      decisionNote: args.decisionNote,
      decisionStatus: args.decisionStatus,
    });
    const { briefMarkdown, ...summary } = plan;
    console.log(JSON.stringify({ ...summary, diffBytes: undefined, briefMarkdownLines: briefMarkdown.split("\n").length }, null, 2));
    console.log("\nDry run — pass --apply to write this checkpoint.");
    return;
  }

  const auth = await resolveContext({ runId: args.runId, workspaceId: args.workspaceId });
  const plan = await buildCapturePlan({
    state,
    workspaceId: auth.workspaceId,
    runId: args.runId,
    testResults,
    decisionNote: args.decisionNote,
    decisionStatus: args.decisionStatus,
  });
  const result = await withTransaction((tx) => captureToWorkspace(auth, plan, tx));
  console.log(
    `Captured ${result.checkpointId} (artifact ${result.artifactId}, blob ${result.blobId}${result.diffBlobDeduped ? ", deduped" : ""}, run link ${result.linkCreated ? "created" : "none"})`,
  );
}

const invokedDirectly = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (invokedDirectly) {
  runCapture(process.argv.slice(2)).then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
