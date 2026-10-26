"use server";

import { revalidatePath } from "next/cache";
import { debriefMeetingArtifact, DebriefNotAllowedError, DebriefUnusableAnswerError } from "@/domains/knowledge/meeting-debrief";
import { designBriefFromArtifact, DesignBriefNotAllowedError, DesignBriefUnusableAnswerError } from "@/domains/knowledge/design-brief";
import { DesignBriefHandoffNotAllowedError, proposeCanvaImport } from "@/domains/knowledge/design-brief-handoff";
import { draftFromLibrary, LibraryEmptyError, WritingUnusableAnswerError } from "@/domains/knowledge/library-writing";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Library-grounded drafts (ASH-301). The draft reads only the owner's
 * library and lands as a document artifact in the gallery; an empty library
 * is an honest refusal, shown where the owner asked.
 */

export async function draftFromLibraryAction(input: { topic: string }): Promise<{ ok: true; artifactId: string } | { ok: false; error: string }> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const topic = input.topic.trim().slice(0, 200);
  if (!topic) return { ok: false, error: "Name what the draft is about." };
  try {
    const result = await draftFromLibrary(auth, { topic });
    revalidatePath("/artifacts");
    return { ok: true, artifactId: result.artifactId };
  } catch (error) {
    if (error instanceof LibraryEmptyError || error instanceof WritingUnusableAnswerError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: error instanceof Error ? error.message : "The draft did not run." };
  }
}

/*
 * The meeting-debrief entry point (ASH-303). The owner asks one artifact to
 * become a batch of review-queue proposals; nothing writes a task or note
 * until a proposal is approved in Reviews. A retry is safe: the batch's
 * dedupe keys resolve the proposals the first run already made.
 */

type DebriefResult = { ok: true; created: number; deduplicated: number } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function debriefArtifactAction(input: { artifactId: string }): Promise<DebriefResult> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  if (!UUID.test(input.artifactId)) return { ok: false, error: "Malformed artifact id." };
  try {
    const result = await debriefMeetingArtifact(auth, input.artifactId);
    const created = result.taskProposalIds.length + result.noteProposalIds.length + result.followUpProposalIds.length;
    revalidatePath("/reviews");
    return { ok: true, created, deduplicated: result.deduplicated };
  } catch (error) {
    if (error instanceof DebriefNotAllowedError || error instanceof DebriefUnusableAnswerError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: error instanceof Error ? error.message : "The debrief did not run." };
  }
}

/*
 * Design brief (ASH-286, partial). One click turns a research artifact into a
 * structured design brief saved as a memo artifact; the Canva handoff is a
 * later change with its own approval gate, so this action never proposes or
 * sends anything.
 */

type BriefResult = { ok: true; briefArtifactId: string; title: string; existing: boolean } | { ok: false; error: string };

export async function designBriefArtifactAction(input: { artifactId: string }): Promise<BriefResult> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  if (!UUID.test(input.artifactId)) return { ok: false, error: "Malformed artifact id." };
  try {
    const result = await designBriefFromArtifact(auth, input.artifactId);
    revalidatePath("/artifacts");
    return { ok: true, briefArtifactId: result.briefArtifactId, title: result.title, existing: result.existing };
  } catch (error) {
    if (error instanceof DesignBriefNotAllowedError || error instanceof DesignBriefUnusableAnswerError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: error instanceof Error ? error.message : "The brief did not run." };
  }
}

/*
 * The Canva handoff (ASH-286). Files a canva.design.import proposal for a
 * generated design brief; the import itself runs only after the owner
 * approves the exact revision in Reviews. Safe to retry: the dedupe key is
 * the brief's current version, so a repeat click resolves the same proposal.
 */

type CanvaImportResult = { ok: true; proposalId: string; deduplicated: boolean } | { ok: false; error: string };

export async function proposeCanvaImportAction(input: { artifactId: string }): Promise<CanvaImportResult> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  if (!UUID.test(input.artifactId)) return { ok: false, error: "Malformed artifact id." };
  try {
    const result = await proposeCanvaImport(auth, input.artifactId);
    revalidatePath("/reviews");
    return { ok: true, proposalId: result.proposalId, deduplicated: result.deduplicated };
  } catch (error) {
    if (error instanceof DesignBriefHandoffNotAllowedError) return { ok: false, error: error.message };
    return { ok: false, error: error instanceof Error ? error.message : "The import proposal was not created." };
  }
}
