import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { sha256Hex } from "@/lib/hash";
import { extractPackages, selectSubtree, type PackageFile } from "../package";
import { failureResult, InspectError, type InspectResult, type SourceRequest } from "./types";

/*
 * Reading a folder on this machine is the one source that can reach outside
 * the repository it was pointed at, because directories have real links and
 * real parents. Two rules keep it contained: the requested folder must resolve
 * (after `realpath`) to somewhere under the allowed root, and the walk never
 * follows a link — a symlink inside the folder is skipped, even when it points
 * back inside, because a bytes map cannot say what it pointed at.
 */

const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;

type LocalRequest = Extract<SourceRequest, { kind: "local" }>;

function rootOf(): string {
  return process.env.SKILLS_LOCAL_ROOT ?? path.join(homedir(), "Projects");
}

/** `~` is text the user typed, not a path the filesystem resolves. */
function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function isUnder(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolvedDirectory(candidate: string, label: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    throw new InspectError("not_found", `There is no folder at ${label}. Check the path and try again.`);
  }
}

/**
 * Walks one directory tree into the flat map `extractPackages` reads. A link is
 * skipped, never followed: its target can sit anywhere, and `lstat` is the only
 * check that sees the link rather than what it points at. It is skipped rather
 * than fatal because a folder holding a stray `node_modules` link is still a
 * usable skill; the omission is reported as a warning so it is not invisible.
 */
async function walk(
  directory: string,
  prefix: string,
  files: Map<string, PackageFile>,
  skipped: string[],
  // Shared across the whole walk; a per-call counter would apply the 5 MB
  // ceiling to each folder instead of the tree.
  budget: { bytes: number },
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // A listing failure is a permissions problem, not an unsafe path; saying
    // "unsafe" would blame the person's path for something they cannot see.
    throw new InspectError(
      "unreadable",
      `A folder inside the skill could not be listed. Check that you can read it, then try again.`,
    );
  }

  // Sorted so the revision below cannot depend on filesystem enumeration order.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

    // `withFileTypes` reports the link itself, but `lstat` is the fact the
    // decision rests on; a dirent can still be a mount point or a race. The
    // tree was designated by the person, so a file changing mid-walk is theirs
    // to retry, not an escape attempt.
    let stats: Stats;
    try {
      stats = await lstat(full);
    } catch {
      throw new InspectError("unsafe_path", `"${relative}" changed while it was being read.`);
    }

    if (stats.isSymbolicLink()) {
      skipped.push(relative);
      continue;
    }
    if (stats.isDirectory()) {
      await walk(full, relative, files, skipped, budget);
      continue;
    }
    if (!stats.isFile()) {
      throw new InspectError(
        "unsafe_path",
        `"${relative}" is a device or socket, not a file. Only regular files can be inspected.`,
      );
    }

    if (files.size >= MAX_FILES) {
      throw new InspectError(
        "too_large",
        `This folder has more than ${MAX_FILES} files; inspect a single skill folder instead.`,
      );
    }

    // The size is checked before the read, so an oversized file costs a stat
    // rather than a 5 MB buffer.
    budget.bytes += stats.size;
    if (budget.bytes > MAX_BYTES) {
      throw new InspectError(
        "too_large",
        `This folder is larger than the 5 MB limit. Inspect a single skill folder instead.`,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(full));
    } catch {
      throw new InspectError(
        "unreadable",
        `"${relative}" exists but could not be read. Check its permissions, then try again.`,
      );
    }
    files.set(relative, { path: relative, bytes });
  }
}

/**
 * `extractPackages` names a skill after the folder that holds its SKILL.md, so
 * the walk keeps the requested folder's own name as the top segment. Otherwise
 * a folder read directly would put SKILL.md at the map root, which the package
 * module deliberately treats as not-a-package.
 */
function underFolder(name: string, files: Map<string, PackageFile>): Map<string, PackageFile> {
  const rooted = new Map<string, PackageFile>();
  for (const [key, file] of files) {
    const path = `${name}/${key}`;
    rooted.set(path, { ...file, path });
  }
  return rooted;
}

/**
 * One digest for the whole inspection. Skills are content-addressed already,
 * so hashing `slug` plus `contentHash` in a fixed order gives the install
 * action a fingerprint of exactly the files it read, with no reliance on
 * directory order.
 */
async function revisionOf(skills: { slug: string; contentHash: string }[]): Promise<string> {
  const sorted = [...skills].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return sha256Hex(sorted.map((skill) => `${skill.slug}:${skill.contentHash}`).join("\n"));
}

export async function inspectLocal(request: LocalRequest): Promise<InspectResult> {
  try {
    const allowedRoot = await resolvedDirectory(expandHome(rootOf()), "the skills root");
    const requested = await resolvedDirectory(path.resolve(expandHome(request.root)), request.root);

    if (!isUnder(allowedRoot, requested)) {
      throw new InspectError(
        "unsafe_path",
        `${request.root} is outside ${path.basename(allowedRoot)}. Move the skill under ${allowedRoot} and try again.`,
      );
    }

    const files = new Map<string, PackageFile>();
    const skipped: string[] = [];
    await walk(requested, "", files, skipped, { bytes: 0 });
    const selected = selectSubtree(files, request.path);
    if (selected.size === 0) {
      throw new InspectError("no_skill_found", `Nothing in ${requested} matches that folder.`);
    }

    const inspected = extractPackages(underFolder(path.basename(requested), selected));
    if (inspected.skills.length === 0) {
      throw new InspectError(
        "no_skill_found",
        `No skill found in ${requested}. A skill is a folder containing a SKILL.md with a description.`,
      );
    }

    const warnings = [...inspected.warnings];
    for (const link of skipped) {
      warnings.push(`${link} is a symbolic link, so it was skipped and not read.`);
    }

    return {
      ok: true,
      sourceKind: "local",
      sourceRef: requested,
      revision: await revisionOf(inspected.skills),
      skills: inspected.skills,
      warnings,
    };
  } catch (error) {
    return failureResult(
      error,
      "Polymath could not finish reading that folder. Try again.",
    );
  }
}
