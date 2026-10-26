import { createHash } from "node:crypto";
import { createProposal } from "@/domains/actions/commands";
import { actionRevisions } from "@/domains/actions/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";

/*
 * ASH-284: propose-only GitHub issue triage. Reading open issues is the
 * gateway's github.issue.read; this module records what the owner is asked
 * to apply - labels, assignees, or a close reason - as a decision-only
 * action proposal. There is deliberately NO executor for this capability:
 * approving in the review queue records the decision and nothing calls
 * GitHub, which is the ticket's "proposal-only" clause. When an apply path
 * lands later, the risk class must rise to external_write and the executor
 * gates (exact-revision binding, account pin) apply.
 */

export const GITHUB_ISSUE_TRIAGE = "github.issue.triage";

export class GitHubTriageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GitHubTriageError";
    this.code = code;
  }
}

export type TriageChanges = {
  addLabels?: string[];
  removeLabels?: string[];
  assignees?: string[];
  closeReason?: "completed" | "not_planned";
};

export type GitHubTriagePayload = {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  changes: TriageChanges;
  rationale: string;
  changesHash: string;
};

const NAME = /^[A-Za-z0-9_.-]+$/;

function cleanList(values: string[] | undefined, what: string): string[] {
  if (!values) return [];
  const out = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  if (out.some((v) => v.length > 100)) throw new GitHubTriageError("invalid_changes", `A ${what} entry is too long.`);
  return out;
}

/*
 * The proposal's dedupe identity is caller-scope plus content: a retry of
 * the same triage replays the pending proposal, and a changed triage for
 * the same issue is a new proposal rather than a silent edit of one the
 * owner may already be reading.
 */
export function triageChangesHash(changes: TriageChanges): string {
  const stable = {
    addLabels: cleanList(changes.addLabels, "label").sort(),
    removeLabels: cleanList(changes.removeLabels, "label").sort(),
    assignees: cleanList(changes.assignees, "assignee").sort(),
    closeReason: changes.closeReason ?? null,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

/** The review card's effect line, built from coordinates and changes only - never from raw issue text. */
export function expectedEffectOf(owner: string, repo: string, issueNumber: number, changes: TriageChanges): string {
  const parts: string[] = [];
  const add = cleanList(changes.addLabels, "label");
  const remove = cleanList(changes.removeLabels, "label");
  const assignees = cleanList(changes.assignees, "assignee");
  if (add.length) parts.push(`add label${add.length === 1 ? "" : "s"} ${add.join(", ")}`);
  if (remove.length) parts.push(`remove label${remove.length === 1 ? "" : "s"} ${remove.join(", ")}`);
  if (assignees.length) parts.push(`assign ${assignees.map((a) => `@${a}`).join(", ")}`);
  if (changes.closeReason) parts.push(`close as ${changes.closeReason === "not_planned" ? "not planned" : "completed"}`);
  return `On ${owner}/${repo}#${issueNumber}: ${parts.join("; ")}. Nothing is applied automatically.`;
}

export function validateTriageInput(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  changes: TriageChanges;
  rationale: string;
}): { changesHash: string; expectedEffect: string } {
  if (!NAME.test(input.owner) || !NAME.test(input.repo)) {
    throw new GitHubTriageError("invalid_repository", "The repository must be an owner and repo name, like ashwinrachhavt/Polymath.");
  }
  if (!Number.isInteger(input.issueNumber) || input.issueNumber < 1) {
    throw new GitHubTriageError("invalid_issue", "The issue number must be a positive integer.");
  }
  const add = cleanList(input.changes.addLabels, "label");
  const remove = cleanList(input.changes.removeLabels, "label");
  const assignees = cleanList(input.changes.assignees, "assignee");
  if (assignees.some((a) => !NAME.test(a))) {
    throw new GitHubTriageError("invalid_changes", "An assignee must be a GitHub login.");
  }
  if (input.changes.closeReason !== undefined && input.changes.closeReason !== "completed" && input.changes.closeReason !== "not_planned") {
    throw new GitHubTriageError("invalid_changes", "A close reason is 'completed' or 'not_planned'.");
  }
  const overlap = add.filter((l) => remove.includes(l));
  if (overlap.length) {
    throw new GitHubTriageError("invalid_changes", `Labels cannot be both added and removed: ${overlap.join(", ")}.`);
  }
  if (!add.length && !remove.length && !assignees.length && !input.changes.closeReason) {
    throw new GitHubTriageError("empty_changes", "There is no triage to propose: name a label, an assignee, or a close reason.");
  }
  return {
    changesHash: triageChangesHash(input.changes),
    expectedEffect: expectedEffectOf(input.owner, input.repo, input.issueNumber, input.changes),
  };
}

export async function proposeGitHubTriage(
  auth: AuthContext,
  input: {
    owner: string;
    repo: string;
    issueNumber: number;
    issueTitle: string;
    changes: TriageChanges;
    rationale: string;
    dedupeKey: string;
    runId?: string | null;
  },
): Promise<{ proposalId: string; deduplicated: boolean; changesHash: string }> {
  const { changesHash, expectedEffect } = validateTriageInput(input);
  const issueTitle = input.issueTitle.trim().slice(0, 200);
  const payload: GitHubTriagePayload = {
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    issueTitle,
    changes: {
      addLabels: cleanList(input.changes.addLabels, "label"),
      removeLabels: cleanList(input.changes.removeLabels, "label"),
      assignees: cleanList(input.changes.assignees, "assignee"),
      ...(input.changes.closeReason ? { closeReason: input.changes.closeReason } : {}),
    },
    rationale: input.rationale.trim().slice(0, 2000),
    changesHash,
  };

  const result = await withTransaction(async (tx) => {
    const created = await createProposal(tx, { workspaceId: auth.workspaceId }, {
      capability: GITHUB_ISSUE_TRIAGE,
      // Decision-only: nothing executes, so this stays prepare. An apply
      // path must raise this to external_write when it lands.
      riskClass: "prepare",
      targetType: "github_issue",
      // targetId stays null: a GitHub issue ref is not a workspace uuid; the
      // coordinates live in the payload.
      title: `Triage ${input.owner}/${input.repo}#${input.issueNumber}${issueTitle ? `: ${issueTitle}` : ""}`,
      expectedEffect,
      dedupeKey: `${input.dedupeKey}:${changesHash}`,
      runId: input.runId ?? null,
      // Issue state moves on without us; a stale triage is worse than none.
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });
    if (!created.deduplicated) {
      await tx.insert(actionRevisions).values({
        workspaceId: auth.workspaceId,
        proposalId: created.proposalId,
        revisionNumber: 1,
        payload,
        preview: null,
      });
    }
    return created;
  });

  return { ...result, changesHash };
}
