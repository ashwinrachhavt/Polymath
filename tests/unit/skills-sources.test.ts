import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { packTar } from "modern-tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveToFiles, selectSubtree } from "@/domains/skills/sources/github";
import { inspectLocal } from "@/domains/skills/sources/local";
import { extractPackages } from "@/domains/skills/package";

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

async function archiveOf(entries: Parameters<typeof packTar>[0]): Promise<Uint8Array> {
  return gzipped(await packTar(entries));
}

/** Runs the adapter and returns only the rejection code, so a test names the failure. */
async function codeOf(run: () => Promise<{ ok: boolean; code?: string }>): Promise<string> {
  const result = await run();
  return result.ok ? "ok" : (result.code ?? "no-code");
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
    expect(await codeOf(async () => {
      try {
        await archiveToFiles(encoder.encode("not a tarball"));
        return { ok: true };
      } catch (error) {
        return error as { ok: false; code: string };
      }
    })).toBe("unsupported_input");
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

  it("reports a folder with no SKILL.md as no_skill_found", async () => {
    await mkdir(path.join(root, "empty"), { recursive: true });
    await writeFile(path.join(root, "empty", "README.md"), "# nothing here\n");
    const result = await inspectLocal({ kind: "local", root: path.join(root, "empty") });
    expect(result).toMatchObject({ ok: false, code: "no_skill_found" });
  });
});
