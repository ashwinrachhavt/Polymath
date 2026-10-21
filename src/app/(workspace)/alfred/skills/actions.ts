"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { inspectSource, parseSource } from "@/domains/skills/inspect";
import { bundledSkill } from "@/domains/skills/bundled";
import { installSkill, removeSkill, setSkillEnabled } from "@/domains/skills/commands";
import type { InspectResult, SourceRequest } from "@/domains/skills/sources/types";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import type { InspectAction, InstallAction, SkillWriteAction } from "./contract";

/*
 * The skills page's mutation surface. Inspecting is a read that touches a
 * provider or the filesystem, so it is member-or-above like the writes; it
 * stores nothing.
 *
 * Install is deliberately stateless. Inspection hands the client the packages
 * and the revision they were read at; install re-reads the source at that
 * revision and installs the package whose folder matches. Nothing is staged
 * between the two calls, so a second tab cannot install a package the first
 * one replaced.
 */

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const revalidate = () => revalidatePath("/alfred/skills");

const inspectInput = z.object({
  source: z.string().trim().min(1).max(2048),
});

const installInput = inspectInput.extend({
  /** The folder the package was read from; part of install identity. */
  sourcePath: z.string().trim().min(1).max(1024),
  /** The revision inspection reported. Install re-reads exactly this. */
  revision: z.string().trim().min(1).max(128),
});

function discoveryOf(result: Extract<InspectResult, { ok: true }>): InspectAction {
  return {
    ok: true,
    sourceKind: result.sourceKind,
    sourceRef: result.sourceRef,
    revision: result.revision,
    warnings: result.warnings,
    skills: result.skills.map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      warnings: skill.warnings,
      fileCount: skill.files.length + 1,
      sourcePath: skill.sourcePath ?? skill.slug,
    })),
  };
}

/*
 * Re-run the same inspection, but pinned where the source allows it. A GitHub
 * commit is a real pin; a folder has no history, so the caller's revision is
 * checked against what is on disk instead and a moved folder is refused rather
 * than installed as something the person never saw.
 */
async function inspectPinned(
  request: SourceRequest,
  revision: string,
): Promise<InspectResult> {
  // A commit is a real pin; a folder has no history, so the local adapter
  // re-reads it and the caller compares the revision it reported.
  return inspectSource(request.kind === "github" ? { ...request, ref: revision } : request);
}

export async function inspectSkillAction(input: { source: string }): Promise<InspectAction> {
  await authorize();
  const parsed = inspectInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Paste an install command, a github.com link, or a folder path." };
  }

  const request = parseSource(parsed.data.source);
  if ("error" in request) return { ok: false, error: request.error };

  const result = await inspectSource(request);
  return result.ok ? discoveryOf(result) : { ok: false, error: result.message };
}

export async function installSkillAction(input: {
  source: string;
  sourcePath: string;
  revision: string;
}): Promise<InstallAction> {
  const auth = await authorize();
  const parsed = installInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "That install is missing its source or revision. Inspect the source again, then install.",
    };
  }

  const request = parseSource(parsed.data.source);
  if ("error" in request) return { ok: false, error: request.error };

  const result = await inspectPinned(request, parsed.data.revision);
  if (!result.ok) return { ok: false, error: result.message };

  if (result.revision !== parsed.data.revision) {
    return {
      ok: false,
      error:
        result.sourceKind === "local"
          ? "The folder changed since you inspected it. Inspect it again, then install."
          : "The repository moved since you inspected it. Inspect it again, then install.",
    };
  }

  const skill = result.skills.find(
    (candidate) => (candidate.sourcePath ?? candidate.slug) === parsed.data.sourcePath,
  );
  if (!skill) {
    return {
      ok: false,
      error: "That package is no longer in the source. Inspect it again and choose a package.",
    };
  }

  try {
    const installed = await installSkill(auth, {
      ...skill,
      sourceKind: result.sourceKind,
      sourceRef: result.sourceRef,
      sourcePath: parsed.data.sourcePath,
      revision: result.revision,
    });
    revalidate();
    return { ok: true, skillId: installed.skillId, created: installed.created };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "The skill did not install. Try again.",
    };
  }
}

const enabledInput = z.object({ id: z.string().uuid(), enabled: z.boolean() });

const bundledInput = z.object({ slug: z.string().trim().min(1).max(80) });

/**
 * Discover ships three procedures as app data. Installing one is the same
 * command as a source install with `bundled` coordinates, so there is one
 * write path and one audit action for every skill in the table.
 */
export async function installBundledSkillAction(input: { slug: string }): Promise<InstallAction> {
  const auth = await authorize();
  const parsed = bundledInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That example no longer exists." };

  const skill = bundledSkill(parsed.data.slug);
  if (!skill) return { ok: false, error: "That example no longer exists. Refresh to see the list." };

  try {
    const installed = await installSkill(auth, {
      ...skill,
      sourceKind: "bundled",
      sourceRef: "bundled",
      sourcePath: skill.sourcePath ?? `examples/${skill.slug}`,
      revision: skill.contentHash,
    });
    revalidate();
    return { ok: true, skillId: installed.skillId, created: installed.created };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "The skill did not install. Try again.",
    };
  }
}

export async function setSkillEnabledAction(input: {
  id: string;
  enabled: boolean;
}): Promise<SkillWriteAction> {
  const auth = await authorize();
  const parsed = enabledInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That skill no longer exists." };

  const { updated } = await setSkillEnabled(auth, parsed.data);
  if (!updated) return { ok: false, error: "That skill no longer exists. Refresh to see the list." };
  revalidate();
  return { ok: true };
}

const removeInput = z.object({ id: z.string().uuid() });

export async function removeSkillAction(input: { id: string }): Promise<SkillWriteAction> {
  const auth = await authorize();
  const parsed = removeInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That skill no longer exists." };

  const { removed } = await removeSkill(auth, parsed.data);
  if (!removed) return { ok: false, error: "That skill no longer exists. Refresh to see the list." };
  revalidate();
  return { ok: true };
}
