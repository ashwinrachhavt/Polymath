import { unpackTar } from "modern-tar";
import { safeFetch, type SafeFetchResult } from "@/lib/safe-fetch";
import { extractPackages, type PackageFile } from "../package";
import { InspectError, type InspectResult, type SourceRequest } from "./types";

/*
 * A GitHub repository arrives as one codeload tarball, pinned to a commit so
 * "inspect" and "install" can never see different trees. The archive is
 * untarred in memory: nothing is written to disk, so a crafted archive has no
 * filesystem to escape into. Every entry is still checked by name and type,
 * because the tarball is attacker-controlled input even when GitHub served it.
 */

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
// A gzip stream can expand far past the bytes it arrived in. The cap keeps a
// compression bomb from turning a 5 MB download into an unbounded buffer.
const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 200;
const MAX_API_BYTES = 256 * 1024;
const API_TIMEOUT_MS = 15_000;
const ARCHIVE_TIMEOUT_MS = 30_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

type GithubRequest = Extract<SourceRequest, { kind: "github" }>;
type FetchFailure = Extract<SafeFetchResult, { ok: false }>;

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

function linkLabel(type: string): string {
  if (type === "symlink") return "a symbolic link";
  if (type === "link") return "a hard link";
  if (type === "character-device" || type === "block-device") return "a device";
  return "a named pipe";
}

/*
 * The archive's names are judged before the wrapper directory is stripped:
 * `repo/../../etc/passwd` still contains a `..` segment, and stripping first
 * would leave a shorter path that looks harmless.
 */
function archivePath(raw: string): string | null {
  if (!raw) {
    throw new InspectError("unsafe_path", "The repository contains a file with an empty name.");
  }
  if (raw.includes("\0")) {
    throw new InspectError(
      "unsafe_path",
      `The path ${JSON.stringify(raw)} contains a NUL byte, so it cannot be read.`,
    );
  }
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new InspectError(
      "unsafe_path",
      `"${raw}" is an absolute path. Only files inside the repository may be read.`,
    );
  }
  if (raw.includes("\\")) {
    throw new InspectError(
      "unsafe_path",
      `"${raw}" uses a backslash separator, which is not a path inside the repository.`,
    );
  }

  const segments = raw.split("/");
  if (segments.includes("..")) {
    throw new InspectError(
      "unsafe_path",
      `"${raw}" climbs out of the repository with "..", so it was not read.`,
    );
  }

  // GitHub wraps the whole tree in one directory named `{repo}-{sha}/`; it is
  // not part of the repository, so every entry loses its first segment.
  const [top, ...rest] = segments;
  if (!top || rest.length === 0) return null;
  return rest.join("/") || null;
}

async function gunzipCapped(gzip: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(gzip);
      controller.close();
    },
  });
  // The DOM types describe `DecompressionStream` as reading `BufferSource`,
  // which no `TransformStream<Uint8Array, …>` accepts; the cast is type-level
  // only and the runtime contract is the same bytes in, bytes out.
  const reader = source
    .pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_EXPANDED_BYTES) {
        await reader.cancel();
        throw new InspectError(
          "too_large",
          `The repository unpacks to more than ${megabytes(MAX_EXPANDED_BYTES)}, which is past what inspection reads.`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof InspectError) throw error;
    throw new InspectError("unsupported_input", "GitHub returned an archive that could not be unpacked. Try again.");
  }

  const tar = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return tar;
}

/**
 * Turns GitHub's `.tar.gz` into the flat path→bytes map `extractPackages`
 * expects. Exported so the archive rules can be tested against fixture bytes
 * without a network call.
 */
export async function archiveToFiles(gzip: Uint8Array): Promise<Map<string, PackageFile>> {
  const tar = await gunzipCapped(gzip);

  let entries;
  try {
    entries = await unpackTar(tar);
  } catch {
    throw new InspectError("unsupported_input", "GitHub returned an archive that is not a readable tar file. Try again.");
  }

  if (entries.length > MAX_ENTRIES) {
    throw new InspectError(
      "too_large",
      `The repository has ${entries.length} entries; at most ${MAX_ENTRIES} can be inspected.`,
    );
  }

  const files = new Map<string, PackageFile>();
  for (const entry of entries) {
    const type = entry.header.type ?? "file";
    if (type === "directory") continue;
    if (type !== "file") {
      // A bytes map cannot say where a link points, and following one would
      // mean reading something outside the repository.
      throw new InspectError(
        "unsafe_path",
        `"${entry.header.name}" is ${linkLabel(type)}. Links and devices are not read from an archive.`,
      );
    }
    const path = archivePath(entry.header.name);
    if (path === null) continue;
    files.set(path, { path, bytes: entry.data ?? new Uint8Array() });
  }
  return files;
}

/**
 * Restricts an archive to the subtree a `--path` asked for. Paths keep their
 * full depth so the folder that owns each SKILL.md is still visible to
 * `extractPackages`; only files outside the subtree are dropped.
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

function githubFailure(failure: FetchFailure, label: string): InspectError {
  if (failure.timedOut) {
    return new InspectError("timeout", `GitHub did not answer in time for ${label}. Try again.`);
  }
  if (failure.rateLimited) {
    return new InspectError(
      "rate_limited",
      "GitHub is limiting requests from this server. Try again in a few minutes.",
    );
  }
  if (failure.status === 404) {
    return new InspectError("not_found", `GitHub has no ${label}. Check the link.`);
  }
  if (failure.status === 401 || failure.status === 403) {
    return new InspectError(
      "private_repo",
      `GitHub would not show ${label} without a sign-in. Private repositories are not supported yet.`,
    );
  }
  if (failure.tooLarge) {
    return new InspectError(
      "too_large",
      `${label} is larger than the ${megabytes(MAX_ARCHIVE_BYTES)} limit for one repository.`,
    );
  }
  return new InspectError("not_found", `GitHub could not be reached for ${label}. ${failure.error}`);
}

async function resolveCommit(owner: string, repo: string, ref?: string): Promise<string> {
  // `HEAD` is the repository's default branch, so an unqualified link costs one
  // request instead of two.
  const target = encodeURIComponent(ref ?? "HEAD");
  const label = `${owner}/${repo}${ref ? ` at "${ref}"` : ""}`;
  const result = await safeFetch(`https://api.github.com/repos/${owner}/${repo}/commits/${target}`, {
    timeoutMs: API_TIMEOUT_MS,
    maxBytes: MAX_API_BYTES,
    failureDetails: true,
  });
  if (!result.ok) throw githubFailure(result, label);

  const body: unknown = (() => {
    try {
      return JSON.parse(new TextDecoder().decode(result.bytes));
    } catch {
      return null;
    }
  })();
  const sha = typeof body === "object" && body !== null ? (body as { sha?: unknown }).sha : undefined;
  if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
    throw new InspectError("not_found", `GitHub did not return a commit for ${label}.`);
  }
  return sha;
}

async function fetchArchive(owner: string, repo: string, sha: string): Promise<Uint8Array> {
  const result = await safeFetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`, {
    timeoutMs: ARCHIVE_TIMEOUT_MS,
    maxBytes: MAX_ARCHIVE_BYTES,
    failureDetails: true,
  });
  if (!result.ok) throw githubFailure(result, `${owner}/${repo} at ${sha.slice(0, 7)}`);
  return result.bytes;
}

function failure(error: unknown): InspectResult {
  if (error instanceof InspectError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return {
    ok: false,
    code: "not_found",
    message: "GitHub could not be read. Try again, or paste the repository link again.",
  };
}

export async function inspectGithub(request: GithubRequest): Promise<InspectResult> {
  const { owner, repo } = request;
  try {
    const sha = await resolveCommit(owner, repo, request.ref);
    const files = await archiveToFiles(await fetchArchive(owner, repo, sha));
    const selected = selectSubtree(files, request.path);
    const label = request.path ? `${owner}/${repo} at "${request.path}"` : `${owner}/${repo}`;

    if (selected.size === 0) {
      throw new InspectError("no_skill_found", `Nothing in ${label} matches that folder.`);
    }

    const { skills, warnings } = extractPackages(selected);
    if (skills.length === 0) {
      throw new InspectError(
        "no_skill_found",
        `No skill found in ${label}. A skill is a folder containing a SKILL.md with a description.`,
      );
    }

    return { ok: true, sourceKind: "github", sourceRef: `${owner}/${repo}`, revision: sha, skills, warnings };
  } catch (error) {
    return failure(error);
  }
}
