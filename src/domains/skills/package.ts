import { createHash } from "node:crypto";
import type { InspectedSkill } from "./manifest";
import type { SkillFile } from "./schema";
import { InspectError } from "./sources/types";

/*
 * Packages are found in a flat path→bytes map, never on disk: the GitHub
 * adapter untars in memory and the local adapter reads a bounded tree, so this
 * module is where every size and path rule is enforced once. Nothing here
 * executes, writes, or fetches.
 *
 * A rejected package throws `InspectError`; the adapters catch it and turn it
 * into an `InspectResult`. Continuing after the first violation would mean
 * guessing which files a caller is willing to lose.
 */

export type PackageFile = {
  path: string;
  bytes: Uint8Array;
  /**
   * Set by an adapter that saw a link entry. A bytes map cannot represent a
   * link target, so the adapter records the fact rather than following it.
   */
  symlink?: boolean;
};

const MAX_FILE_BYTES = 128 * 1024;
const MAX_FILES_PER_PACKAGE = 64;
const MAX_PACKAGE_BYTES = 512 * 1024;
const SKILL_FILE = "SKILL.md";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

function bytesLabel(bytes: number): string {
  // Ceiling, not rounding: 128 KB + 1 byte must never print as "128 KB" in a
  // message that says the file is over the 128 KB limit.
  if (bytes >= 1024 * 1024) return `${Math.ceil(bytes / (1024 * 1024))} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

function assertSafePath(path: string): void {
  if (!path) {
    throw new InspectError("unsafe_path", "The repository contains a file with an empty name.");
  }
  if (path.includes("\0")) {
    throw new InspectError(
      "unsafe_path",
      `The path ${JSON.stringify(path)} contains a NUL byte, so it cannot be read.`,
    );
  }
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new InspectError(
      "unsafe_path",
      `"${path}" is an absolute path. Only files inside the package may be read.`,
    );
  }
  if (path.includes("\\")) {
    throw new InspectError(
      "unsafe_path",
      `"${path}" uses a backslash separator, which is not a path inside the package.`,
    );
  }
  if (path.split("/").includes("..")) {
    throw new InspectError(
      "unsafe_path",
      `"${path}" climbs out of the package with "..", so it was not read.`,
    );
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isUnder(path: string, directory: string): boolean {
  return directory === "" || path === directory || path.startsWith(`${directory}/`);
}

/**
 * Frontmatter is a small YAML subset on purpose: only `description` is read,
 * because that is all Eve requires and all the library shows. A hand-rolled
 * parser here beats a dependency whose failure mode is a parse error nobody
 * can act on.
 */
function readFrontmatter(text: string): { description: string; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const body = text.slice(match[0].length).replace(/^\r?\n/, "");
  const lines = match[1].split(/\r?\n/);
  let description = "";

  for (let i = 0; i < lines.length; i += 1) {
    const field = /^description:[ \t]*(.*)$/.exec(lines[i]);
    if (!field) continue;

    const value = field[1].trim();
    // `>` and `|` may carry chomping and indentation indicators (`>-`, `|2-`);
    // the folded/literal choice is what matters here, not the chomping.
    const block = /^([>|])([+-]?\d*|[0-9][+-]?)$/.exec(value);
    if (block || value === "") {
      const collected: string[] = [];
      while (i + 1 < lines.length && /^[ \t]+/.test(lines[i + 1])) {
        i += 1;
        collected.push(lines[i].trim());
      }
      description = collected.join(block?.[1] === "|" ? "\n" : " ").trim();
    } else {
      description = value.replace(/^(["'])(.*)\1$/, "$2").trim();
    }
    break;
  }

  return { description, body };
}

/**
 * A SKILL.md at the top of the map is not a package: the brief defines one as
 * a *directory* holding SKILL.md, and there is no folder to name it after. It
 * is ignored rather than fatal so a repository with a README-style root
 * SKILL.md still yields its real packages.
 */
function packageRoots(paths: string[]): string[] {
  return paths
    .filter((path) => baseName(path) === SKILL_FILE)
    .map(directoryOf)
    .filter((root) => root !== "");
}

function ownerOf(path: string, roots: string[]): string | null {
  let owner: string | null = null;
  for (const root of roots) {
    if (isUnder(path, root) && (owner === null || root.length > owner.length)) owner = root;
  }
  return owner;
}

type Decoded = { text: string } | { reason: "oversized" | "not_text"; warning: string };

/** Decodes one file or says why it cannot be used; callers decide whether that is fatal. */
function decodeFile(file: PackageFile): Decoded {
  if (file.bytes.byteLength > MAX_FILE_BYTES) {
    return {
      reason: "oversized",
      warning: `${file.path} is ${bytesLabel(file.bytes.byteLength)}; files over ${bytesLabel(MAX_FILE_BYTES)} are skipped.`,
    };
  }
  try {
    return { text: utf8.decode(file.bytes) };
  } catch {
    return { reason: "not_text", warning: `${file.path} is not UTF-8 text, so it was skipped.` };
  }
}

/** Decodes one file, or records why it was omitted and returns null. */
function readText(file: PackageFile, warnings: string[]): string | null {
  const decoded = decodeFile(file);
  if ("warning" in decoded) {
    warnings.push(decoded.warning);
    return null;
  }
  return decoded.text;
}

function inspectPackage(root: string, packageFiles: PackageFile[]): {
  skill: InspectedSkill;
  warnings: string[];
} {
  const warnings: string[] = [];
  const label = root || ".";

  if (packageFiles.length > MAX_FILES_PER_PACKAGE) {
    throw new InspectError(
      "too_large",
      `"${label}" has ${packageFiles.length} files; a package may have at most ${MAX_FILES_PER_PACKAGE}.`,
    );
  }

  const totalBytes = packageFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (totalBytes > MAX_PACKAGE_BYTES) {
    throw new InspectError(
      "too_large",
      `"${label}" is ${bytesLabel(totalBytes)}; a package may be at most ${bytesLabel(MAX_PACKAGE_BYTES)}.`,
    );
  }

  const directoryName = baseName(root);
  const slug = slugify(directoryName);
  if (!SLUG_PATTERN.test(slug)) {
    throw new InspectError(
      "invalid_metadata",
      `"${label}" does not produce a usable skill name. Rename the folder to letters, digits, or hyphens.`,
    );
  }

  const skillPath = `${root}/${SKILL_FILE}`;
  const skillFile = packageFiles.find((file) => file.path === skillPath);
  if (!skillFile) {
    throw new InspectError("invalid_metadata", `"${skillPath}" disappeared during inspection.`);
  }

  const decoded = decodeFile(skillFile);
  if ("warning" in decoded) {
    // Name the real problem: the file exists, so "needs a description" would
    // send the author looking at frontmatter that is probably fine.
    throw new InspectError(
      "invalid_metadata",
      decoded.reason === "oversized"
        ? `"${skillPath}" is ${bytesLabel(skillFile.bytes.byteLength)}, over the ${bytesLabel(MAX_FILE_BYTES)} limit for one file, so it cannot be read.`
        : `"${skillPath}" is not UTF-8 text, so it cannot be read as a skill.`,
    );
  }

  const metadata = readFrontmatter(decoded.text);
  if (!metadata || !metadata.description) {
    throw new InspectError(
      "invalid_metadata",
      `"${skillPath}" needs a description at the top of the file, inside a "---" block: "description: what this skill is for".`,
    );
  }

  const kept: SkillFile[] = [];
  for (const file of packageFiles) {
    const relativePath = file.path.slice(root.length + 1);
    if (relativePath === SKILL_FILE) continue;
    const text = readText(file, warnings);
    if (text !== null) kept.push({ path: relativePath, text });
  }

  const skill: InspectedSkill = {
    // The brief's naming rule: the folder name slugged is the name, so a card
    // and its key can never disagree about what this package is called.
    name: slug,
    slug,
    description: metadata.description,
    body: metadata.body,
    files: kept,
    warnings,
    contentHash: "",
    // Identity in the skills table is the folder, not the display name: two
    // packages in one repository can share a slug only in the sense that the
    // extractor already refuses duplicates; the path is what tells a re-import
    // of a moved package from a second install of the same one.
    sourcePath: root,
  };
  skill.contentHash = contentHashOf(skill);
  return { skill, warnings };
}

/**
 * Restricts a tree to the subtree a `--path` or folder selection asked for.
 * Keys keep their full depth so the folder that owns each SKILL.md is still
 * visible to `extractPackages`; only files outside the subtree are dropped.
 * Both adapters use this, so the trimming rule exists once.
 */
export function selectSubtree(files: Map<string, PackageFile>, path?: string): Map<string, PackageFile> {
  const prefix = path?.replace(/^\/+|\/+$/g, "");
  if (!prefix) return files;
  const selected = new Map<string, PackageFile>();
  for (const [key, file] of files) {
    if (key === prefix || key.startsWith(`${prefix}/`)) selected.set(key, file);
  }
  return selected;
}

export function extractPackages(files: Map<string, PackageFile>): {
  skills: InspectedSkill[];
  warnings: string[];
} {
  for (const file of files.values()) {
    assertSafePath(file.path);
    if (file.symlink) {
      throw new InspectError(
        "unsafe_path",
        `"${file.path}" is a link. Links are not followed; replace it with the file it points to.`,
      );
    }
  }

  const sorted = [...files.values()].sort((a, b) => compareCodeUnits(a.path, b.path));
  const roots = packageRoots(sorted.map((file) => file.path));
  const skills: InspectedSkill[] = [];
  const warnings: string[] = [];
  const slugs = new Map<string, string>();

  for (const root of roots) {
    const { skill } = inspectPackage(
      root,
      sorted.filter((file) => ownerOf(file.path, roots) === root),
    );
    const takenBy = slugs.get(skill.slug);
    if (takenBy !== undefined) {
      throw new InspectError(
        "invalid_metadata",
        `Two folders both become the skill name "${skill.slug}": "${takenBy}" and "${root}". Rename one folder so the names differ.`,
      );
    }
    slugs.set(skill.slug, root);
    skills.push(skill);
    warnings.push(...skill.warnings);
  }

  return { skills, warnings };
}

/*
 * Code-unit order, not `localeCompare`: the latter depends on the host locale
 * and reports equal for NFC and NFD spellings of the same string, so the hash
 * would differ between machines and could still look insertion-ordered.
 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Length-prefixed parts, so no separator choice can collide with content: the
 * byte count is hashed before each field, then the field. Sorted paths make the
 * digest independent of map insertion order.
 */
export function contentHashOf(skill: InspectedSkill): string {
  const hash = createHash("sha256");
  const part = (value: string) => {
    hash.update(`${byteLength(value)}:`);
    hash.update(value);
  };

  part(skill.description);
  // The body lives in SKILL.md, which is not in `files`; without it an edit to
  // the procedure would leave the hash unchanged and a re-import would look
  // identical.
  part(skill.body);
  for (const file of [...skill.files].sort((a, b) => compareCodeUnits(a.path, b.path))) {
    part(file.path);
    part(file.text);
  }
  return hash.digest("hex");
}
