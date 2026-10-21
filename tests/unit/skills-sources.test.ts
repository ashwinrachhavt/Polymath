import { gzipSync } from "node:zlib";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { packTar } from "modern-tar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { archiveToFiles, githubFailure, resolveCommit } from "@/domains/skills/sources/github";
import { inspectLocal } from "@/domains/skills/sources/local";
import { extractPackages, selectSubtree } from "@/domains/skills/package";

/*
 * The adapters are tested against bytes and folders they were handed, never
 * the network: the GitHub fixture is the tarball a real codeload response
 * has, and the local tests build a temporary tree. A test that needed a live
 * repository would fail for reasons this code does not control.
 */

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "skills-repo.tar.gz");
const encoder = new TextEncoder();

async function gzipped(tar: Uint8Array): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(tar);
      controller.close();
    },
    }).pipeThrough(new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** zgrep's counterpart: synchronous so a bomb can be built without a stream. */
function gzipOf(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(bytes));
}

async function archiveOf(entries: Parameters<typeof packTar>[0]): Promise<Uint8Array> {
  return gzipped(await packTar(entries));
}

describe("github archive", () => {
  it("strips the wrapper directory and finds the skill with its sibling file", async () => {
    const files = await archiveToFiles(new Uint8Array(await readFile(FIXTURE)));
    expect([...files.keys()].sort()).toEqual([
      "README.md",
      "skills/research/SKILL.md",
      "skills/research/references/checklist.md",
    ]);

    const { skills } = extractPackages(files);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("research");
    expect(skills[0].description).toBe("Digs through sources and keeps the citations.");
    expect(skills[0].files.map((file) => file.path)).toEqual(["references/checklist.md"]);
    expect(skills[0].files[0].text).toContain("Every claim cites a source");
  });

  it("restricts to a subtree and drops everything outside it", async () => {
    const files = await archiveToFiles(new Uint8Array(await readFile(FIXTURE)));
    const selected = selectSubtree(files, "skills/research");
    expect([...selected.keys()].sort()).toEqual([
      "skills/research/SKILL.md",
      "skills/research/references/checklist.md",
    ]);
    expect(extractPackages(selected).skills[0].name).toBe("research");

    expect(selectSubtree(files, "nowhere").size).toBe(0);
  });

  it("rejects an entry whose name climbs out with ..", async () => {
    const archive = await archiveOf([{ header: { name: "repo/../../etc/passwd", size: 4 }, body: "pw!\n" }]);
    await expect(archiveToFiles(archive)).rejects.toMatchObject({
      code: "unsafe_path",
      message: expect.stringContaining('".."'),
    });
  });

  it("rejects an absolute entry name", async () => {
    const archive = await archiveOf([{ header: { name: "/etc/passwd", size: 4 }, body: "pw!\n" }]);
    await expect(archiveToFiles(archive)).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("rejects a symlink entry instead of following it", async () => {
    const archive = await archiveOf([
      { header: { name: "repo/skills/research/SKILL.md", type: "symlink", size: 0, linkname: "/etc/passwd" } },
    ]);
    await expect(archiveToFiles(archive)).rejects.toMatchObject({
      code: "unsafe_path",
      message: expect.stringContaining("symbolic link"),
    });
  });

  it("rejects a hard link entry", async () => {
    const archive = await archiveOf([
      { header: { name: "repo/skills/research/notes.md", type: "link", size: 0, linkname: "repo/README.md" } },
    ]);
    await expect(archiveToFiles(archive)).rejects.toMatchObject({
      code: "unsafe_path",
      message: expect.stringContaining("hard link"),
    });
  });

  it("rejects more than 200 entries", async () => {
    const entries = Array.from({ length: 201 }, (_, index) => ({
      header: { name: `repo/file-${index}.md`, size: 1 },
      body: "x",
    }));
    await expect(archiveToFiles(await archiveOf(entries))).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects bytes that are not a gzip stream", async () => {
    await expect(archiveToFiles(encoder.encode("not a tarball"))).rejects.toMatchObject({
      code: "unsupported_input",
    });
  });

  it("refuses an archive that expands past the decompression cap", async () => {
    // 30 MB of zeros compress to a few KB. The cap is what stops that ratio
    // from becoming a 30 MB buffer; the entry count never gets a say.
    const bomb = gzipOf(new Uint8Array(30 * 1024 * 1024));
    await expect(archiveToFiles(bomb)).rejects.toMatchObject({ code: "too_large", message: expect.stringContaining("20 MB") });
  });
});

describe("github api status map", () => {
  const fixture = new TextEncoder().encode("a".repeat(40));
  let server: Server;
  let base: string;
  let lastAccept = "";
  const previousBase = process.env.GITHUB_API_BASE;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/repos/acme/missing/commits/HEAD") return void response.writeHead(404).end();
      if (request.url === "/repos/acme/secret/commits/HEAD") return void response.writeHead(404).end();
      if (request.url === "/repos/acme/limited/commits/HEAD") {
        return void response.writeHead(403, { "x-ratelimit-remaining": "0" }).end();
      }
      if (request.url === "/repos/acme/throttled/commits/HEAD") return void response.writeHead(429).end();
      if (request.url === "/repos/acme/forbidden/commits/HEAD") return void response.writeHead(403).end();
      if (request.url === "/repos/acme/nobranch/commits/nope") return void response.writeHead(422).end();
      if (request.url === "/repos/acme/slow/commits/HEAD") return; // never answers
      if (request.url === "/repos/acme/ok/commits/HEAD") {
        lastAccept = request.headers.accept ?? "";
        return void response.writeHead(200, { "content-type": "application/vnd.github.sha" }).end(fixture);
      }
      response.writeHead(500).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.GITHUB_API_BASE = base;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
    if (previousBase === undefined) delete process.env.GITHUB_API_BASE;
    else process.env.GITHUB_API_BASE = previousBase;
  });

  const lookup = (repo: string, ref?: string, timeoutMs?: number) =>
    resolveCommit("acme", repo, ref, { allowPrivateAddresses: true, timeoutMs }).then(
      (sha) => ({ ok: true as const, sha }),
      // `message` is non-enumerable on an Error, so it is copied by hand.
      (error: { code: string; message: string }) => ({ ok: false as const, code: error.code, message: error.message }),
    );

  it("returns the sha GitHub answers with, asking only for the sha", async () => {
    expect(await lookup("ok")).toEqual({ ok: true, sha: "a".repeat(40) });
    // Without the sha media type the same call returns the whole commit with
    // every patch, which is what the 1 KB cap would then cut off.
    expect(lastAccept).toBe("application/vnd.github.sha");
  });

  it("treats a 404 as missing or private, and says so", async () => {
    const result = await lookup("secret");
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    if (result.ok) return;
    expect(result.message).toContain("or it is private");
  });

  it("treats an unknown branch's 422 as a missing branch, not an outage", async () => {
    const result = await lookup("nobranch", "nope");
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    if (result.ok) return;
    expect(result.message).toContain("branch or commit");
  });

  it("tells a rate-limited 403 and a 429 apart from a plain 403", async () => {
    expect(await lookup("limited")).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await lookup("throttled")).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await lookup("forbidden")).toMatchObject({ ok: false, code: "private_repo" });
  });

  it("times out", async () => {
    expect(await lookup("slow", undefined, 200)).toMatchObject({ ok: false, code: "timeout" });
  });

  it("does not present an unmodelled answer as a missing repository", async () => {
    const failure = githubFailure(
      { ok: false, error: "The site answered with status 500.", status: 500 },
      "acme/ok",
      "the 5 MB limit",
    );
    expect(failure.code).toBe("unavailable");
  });
});

describe("local folder", () => {
  const previousRoot = process.env.SKILLS_LOCAL_ROOT;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "skills-local-"));
    process.env.SKILLS_LOCAL_ROOT = root;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.SKILLS_LOCAL_ROOT;
    else process.env.SKILLS_LOCAL_ROOT = previousRoot;
  });

  async function writeSkill(directory: string): Promise<void> {
    await mkdir(path.join(directory, "references"), { recursive: true });
    await writeFile(
      path.join(directory, "SKILL.md"),
      "---\nname: research\ndescription: Digs through sources.\n---\n\nRead the source first.\n",
    );
    await writeFile(path.join(directory, "references", "checklist.md"), "- cite it\n");
  }

  it("reads one skill and reports the real path as the source ref", async () => {
    await writeSkill(path.join(root, "research"));
    const result = await inspectLocal({ kind: "local", root: path.join(root, "research") });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceKind).toBe("local");
    expect(result.sourceRef).toBe(await realpath(path.join(root, "research")));
    expect(result.skills.map((skill) => skill.name)).toEqual(["research"]);
    expect(result.skills[0].files.map((file) => file.path)).toEqual(["references/checklist.md"]);
    expect(result.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a folder outside the configured root", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "skills-outside-"));
    try {
      await writeSkill(path.join(outside, "research"));
      const result = await inspectLocal({ kind: "local", root: path.join(outside, "research") });
      expect(result).toMatchObject({ ok: false, code: "unsafe_path" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("skips a symlink that points outside the root and does not read through it", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "skills-outside-"));
    try {
      await writeFile(path.join(outside, "secret.md"), "not part of the skill\n");
      const directory = path.join(root, "research");
      await writeSkill(directory);
      await symlink(path.join(outside, "secret.md"), path.join(directory, "references", "escape.md"));

      const result = await inspectLocal({ kind: "local", root: directory });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.skills[0].files.map((file) => file.path)).toEqual(["references/checklist.md"]);
      expect(JSON.stringify(result)).not.toContain("not part of the skill");
      expect(result.warnings.some((warning) => warning.includes("symbolic link"))).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reports a missing folder as not_found rather than an empty result", async () => {
    const result = await inspectLocal({ kind: "local", root: path.join(root, "absent") });
    expect(result).toMatchObject({ ok: false, code: "not_found" });
  });

  it("stops at the 200-file cap", async () => {
    const directory = path.join(root, "many");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), "---\ndescription: Many files.\n---\n\nBody.\n");
    for (let index = 0; index < 201; index += 1) {
      await writeFile(path.join(directory, `note-${index}.md`), "x");
    }
    expect(await inspectLocal({ kind: "local", root: directory })).toMatchObject({
      ok: false,
      code: "too_large",
      message: expect.stringContaining("200"),
    });
  });

  it("stops at the 5 MB budget across the tree, not per folder", async () => {
    const directory = path.join(root, "heavy");
    await mkdir(path.join(directory, "part-a"), { recursive: true });
    await mkdir(path.join(directory, "part-b"), { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), "---\ndescription: Heavy.\n---\n\nBody.\n");
    // Each folder is under 5 MB; together they are over it. A per-folder
    // counter would let this through.
    await writeFile(path.join(directory, "part-a", "blob.bin"), Buffer.alloc(3 * 1024 * 1024));
    await writeFile(path.join(directory, "part-b", "blob.bin"), Buffer.alloc(3 * 1024 * 1024));
    expect(await inspectLocal({ kind: "local", root: directory })).toMatchObject({
      ok: false,
      code: "too_large",
      message: expect.stringContaining("5 MB"),
    });
  });

  it("reports a folder with no SKILL.md as no_skill_found", async () => {
    await mkdir(path.join(root, "empty"), { recursive: true });
    await writeFile(path.join(root, "empty", "README.md"), "# nothing here\n");
    const result = await inspectLocal({ kind: "local", root: path.join(root, "empty") });
    expect(result).toMatchObject({ ok: false, code: "no_skill_found" });
  });
});
