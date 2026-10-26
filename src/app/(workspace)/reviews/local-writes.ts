import type { AuthContext } from "@/domains/identity/resolve";
import { approveArtifactRevision } from "@/domains/knowledge/revision-proposals";
import { approveNoteProposal } from "@/domains/knowledge/note-proposals";
import { approveTaskProposal } from "@/domains/work/proposals";
import { approveContactProposal } from "@/domains/crm/propose-from-senders";

/*
 * The single classification of an approval's local effect. A capability whose
 * approval writes inside Polymath (rather than through a provider executor)
 * is registered here, and the decide action dispatches through this map - so
 * the review card's decision-only caveat (./decision-scope) reads the same
 * source the approval path executes, and the two cannot drift. A capability
 * in neither this map nor the provider executor registry is decision-only:
 * approval records the decision and nothing runs.
 */
export type LocalWriteInput = { proposalId: string; expectedVersion: number; revisionId: string };

export const LOCAL_WRITERS: Record<string, { apply: (auth: AuthContext, input: LocalWriteInput) => Promise<unknown>; failure: string }> = {
  "artifacts.revise": { apply: approveArtifactRevision, failure: "The approved revision was not applied." },
  "tasks.create": { apply: approveTaskProposal, failure: "The approved task was not created." },
  "notes.create": { apply: approveNoteProposal, failure: "The approved note was not created." },
  // A sender-to-contact proposal: approval creates the contact, company and
  // thread record in one idempotent transaction (ASH-287).
  "crm.contact.create": { apply: approveContactProposal, failure: "The approved contact was not created." },
};
