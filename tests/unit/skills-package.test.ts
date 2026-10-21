import { describe, expect, it } from "vitest";
import { contentHashOf, extractPackages, type PackageFile } from "@/domains/skills/package";

const encoder = new TextEncoder();

function file(path: string, text: string | Uint8Array): PackageFile {
  return { path, bytes: typeof text === "string" ? encoder.encode(text) : text };
}

function skill(description: string, body = "Follow these steps."): string {
  return `---\nname: research\ndescription: ${description}\n---\n\n${body}\n`;
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? "no-code";
  }
  return "no-throw";
}

describe("extractPackages", () => {
  it("finds one package per SKILL.md and keeps its own files", () => {
    const { skills, warnings } = extractPackages(
      new Map([
        ["repo/README.md", file("repo/README.md", "# Repo")],
        ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("Digs things up."))],
        ["repo/skills/research/references/checklist.md", file("repo/skills/research/references/checklist.md", "- one")],
        ["repo/skills/writing/SKILL.md", file("repo/skills/writing/SKILL.md", skill("Writes things down."))],
      ]),
    );

    expect(warnings).toEqual([]);
    expect(skills.map((s) => s.slug)).toEqual(["research", "writing"]);
    const research = skills[0];
    expect(research.description).toBe("Digs things up.");
    expect(research.body).toBe("Follow these steps.\n");
    expect(research.files.map((f) => f.path)).toEqual(["references/checklist.md"]);
  });

  it("rejects a package without a description", () => {
    const files = new Map([
      ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", "---\nname: research\n---\n\nBody\n")],
    ]);
    expect(codeOf(() => extractPackages(files))).toBe("invalid_metadata");
  });

  it("rejects a path that climbs out with ..", () => {
    const files = new Map([["repo/../outside/SKILL.md", file("repo/../outside/SKILL.md", skill("Escapes."))]]);
    expect(() => extractPackages(files)).toThrow(/climbs out/);
    expect(codeOf(() => extractPackages(files))).toBe("unsafe_path");
  });

  it("rejects an absolute path", () => {
    const files = new Map([["/etc/SKILL.md", file("/etc/SKILL.md", skill("Absolute."))]]);
    expect(() => extractPackages(files)).toThrow(/absolute path/);
    expect(codeOf(() => extractPackages(files))).toBe("unsafe_path");
  });

  it("warns and omits a file over 128 KB", () => {
    const big = new Uint8Array(200 * 1024).fill(0x61);
    const { skills, warnings } = extractPackages(
      new Map([
        ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("Has a big file."))],
        ["repo/skills/research/big.txt", file("repo/skills/research/big.txt", big)],
      ]),
    );

    expect(skills[0].files.map((f) => f.path)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("big.txt");
    expect(skills[0].warnings).toEqual(warnings);
  });

  it("warns and omits a file that is not UTF-8", () => {
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x81]);
    const { skills, warnings } = extractPackages(
      new Map([
        ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("Has a binary."))],
        ["repo/skills/research/logo.png", file("repo/skills/research/logo.png", binary)],
      ]),
    );

    expect(skills[0].files).toEqual([]);
    expect(warnings[0]).toContain("not UTF-8");
  });

  it("rejects a path containing a NUL byte", () => {
    const files = new Map([["repo/skills/research/\0hidden", file("repo/skills/research/\0hidden", "x")]]);
    expect(() => extractPackages(files)).toThrow(/NUL byte/);
    expect(codeOf(() => extractPackages(files))).toBe("unsafe_path");
  });

  it("rejects a link entry instead of following it", () => {
    const files = new Map<string, PackageFile>([
      ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("Linked."))],
      ["repo/skills/research/escape", { ...file("repo/skills/research/escape", "/etc"), symlink: true }],
    ]);
    expect(() => extractPackages(files)).toThrow(/is a link/);
    expect(codeOf(() => extractPackages(files))).toBe("unsafe_path");
  });

  it("rejects a package with more than 64 files", () => {
    const files = new Map<string, PackageFile>([
      ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("Too many files."))],
    ]);
    for (let i = 0; i < 64; i += 1) {
      const path = `repo/skills/research/notes/${i}.md`;
      files.set(path, file(path, "note"));
    }

    expect(codeOf(() => extractPackages(files))).toBe("too_large");
    expect(() => extractPackages(files)).toThrow(/at most 64/);
  });

  it("rejects a package over 512 KB in total", () => {
    const chunk = new Uint8Array(120 * 1024).fill(0x61);
    const files = new Map<string, PackageFile>([
      ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("Too big."))],
      ["repo/skills/research/a.txt", file("repo/skills/research/a.txt", chunk)],
      ["repo/skills/research/b.txt", file("repo/skills/research/b.txt", chunk)],
      ["repo/skills/research/c.txt", file("repo/skills/research/c.txt", chunk)],
      ["repo/skills/research/d.txt", file("repo/skills/research/d.txt", chunk)],
      ["repo/skills/research/e.txt", file("repo/skills/research/e.txt", chunk)],
    ]);

    expect(codeOf(() => extractPackages(files))).toBe("too_large");
    expect(() => extractPackages(files)).toThrow(/at most 512 KB/);
  });

  it("rejects two packages that slug to the same name", () => {
    const files = new Map([
      ["repo/skills/Research Notes/SKILL.md", file("repo/skills/Research Notes/SKILL.md", skill("Spaces."))],
      ["repo/skills/research-notes/SKILL.md", file("repo/skills/research-notes/SKILL.md", skill("Hyphens."))],
    ]);
    expect(() => extractPackages(files)).toThrow(/both become the skill name "research-notes"/);
  });

  it("ignores a root-level SKILL.md rather than calling it a package", () => {
    const { skills } = extractPackages(
      new Map([
        ["SKILL.md", file("SKILL.md", skill("Root readme."))],
        ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("A package."))],
      ]),
    );
    expect(skills.map((s) => s.slug)).toEqual(["research"]);
  });

  it("reads a folded description written with a chomping indicator", () => {
    const text = "---\ndescription: >-\n  Folded over\n  two lines.\n---\n\nBody\n";
    const { skills } = extractPackages(
      new Map([["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", text)]]),
    );
    expect(skills[0].description).toBe("Folded over two lines.");
  });

  it("names an oversized SKILL.md as the problem, not a missing description", () => {
    const big = new TextEncoder().encode(`---\ndescription: fine\n---\n${"x".repeat(200 * 1024)}`);
    const files = new Map([
      ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", big)],
    ]);
    expect(() => extractPackages(files)).toThrow(/over the 128 KB limit/);
    expect(() => extractPackages(files)).not.toThrow(/needs a description/);
  });
});

describe("contentHashOf", () => {
  it("is independent of map insertion order", () => {
    const entries: Array<[string, PackageFile]> = [
      ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("Same everywhere."))],
      ["repo/skills/research/a.md", file("repo/skills/research/a.md", "alpha")],
      ["repo/skills/research/b.md", file("repo/skills/research/b.md", "beta")],
    ];

    const forward = extractPackages(new Map(entries)).skills[0];
    const backward = extractPackages(new Map([...entries].reverse())).skills[0];

    expect(forward.contentHash).toBe(backward.contentHash);
    expect(forward.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a file changes", () => {
    const first = extractPackages(
      new Map([
        ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("First."))],
        ["repo/skills/research/a.md", file("repo/skills/research/a.md", "alpha")],
      ]),
    ).skills[0];
    const second = extractPackages(
      new Map([
        ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("First."))],
        ["repo/skills/research/a.md", file("repo/skills/research/a.md", "alpha changed")],
      ]),
    ).skills[0];

    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it("changes when only the procedure body changes", () => {
    const before = extractPackages(
      new Map([
        ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("Same.", "Step one."))],
      ]),
    ).skills[0];
    const after = extractPackages(
      new Map([
        ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("Same.", "Step two."))],
      ]),
    ).skills[0];

    expect(before.contentHash).not.toBe(after.contentHash);
  });

  it("cannot be collided by a NUL in file text", () => {
    // Two different packages whose concatenation is identical if a NUL is used
    // as the only separator: file "a" with text "x" + file "b" with "y", vs
    // file "a" with text "x\0b\0y". Length prefixes must keep them apart.
    const first = extractPackages(
      new Map([
        ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("Collide."))],
        ["repo/skills/research/a", file("repo/skills/research/a", "x")],
        ["repo/skills/research/b", file("repo/skills/research/b", "y")],
      ]),
    ).skills[0];
    const second = extractPackages(
      new Map([
        ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("Collide."))],
        ["repo/skills/research/a", file("repo/skills/research/a", "x\0b\0y")],
      ]),
    ).skills[0];

    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it("orders by code units, so NFC and NFD paths hash the same everywhere", () => {
    // "é" as one code point vs "e" + combining acute. `localeCompare` calls
    // these equal, which makes the sort dependent on insertion order.
    const nfc = "\u00e9.md";
    const nfd = "e\u0301.md";
    const build = (paths: string[]) =>
      extractPackages(
        new Map([
          ["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("Both sorts."))],
          ...paths.map((name) => {
            const path = `repo/skills/research/${name}`;
            return [path, file(path, name)] as [string, PackageFile];
          }),
        ]),
      ).skills[0].contentHash;

    expect(build([nfc, nfd])).toBe(build([nfd, nfc]));
    expect(contentHashOf(
      extractPackages(
        new Map([["repo/skills/research/SKILL.md", file("repo/skills/research/SKILL.md", skill("Both sorts."))]]),
      ).skills[0],
    )).toMatch(/^[0-9a-f]{64}$/);
  });
});
