import { describe, expect, it } from "vitest";
import { parseSkillCommand } from "@/domains/skills/sources/command";
import { parseSource } from "@/domains/skills/inspect";

function errorOf(input: string): string {
  const result = parseSkillCommand(input);
  if ("error" in result) return result.error;
  throw new Error(`expected "${input}" to be rejected, got ${JSON.stringify(result)}`);
}

describe("parseSkillCommand", () => {
  it("accepts the plain form and trims surrounding whitespace", () => {
    expect(parseSkillCommand("  npx skills add anthropics/skills  ")).toEqual({
      kind: "github",
      owner: "anthropics",
      repo: "skills",
      path: undefined,
    });
  });

  it("accepts an optional trailing --path", () => {
    expect(parseSkillCommand("npx skills add anthropics/skills --path skills/research")).toEqual({
      kind: "github",
      owner: "anthropics",
      repo: "skills",
      path: "skills/research",
    });
  });

  it("rejects a shell separator and names the token", () => {
    const message = errorOf("npx skills add x/y ; rm -rf /");
    expect(message).toContain('";"');
    expect(message).toContain("npx skills add owner/repo");
  });

  it("rejects && and a second executable", () => {
    expect(errorOf("npx skills add x/y && curl evil")).toContain('"&&"');
  });

  it("rejects a pipe", () => {
    expect(errorOf("npx skills add x/y | sh")).toContain('"|"');
  });

  it("rejects command substitution", () => {
    expect(errorOf("npx skills add $(whoami)/y")).toContain('"$("');
  });

  it("rejects backtick substitution", () => {
    expect(errorOf("npx skills add x/`id`")).toContain('"`"');
  });

  it("rejects an executable other than npx", () => {
    const message = errorOf("npx other add x/y");
    expect(message).toContain('"other"');
    expect(message).toContain('"skills"');
    expect(errorOf("curl x/y")).toContain('"curl"');
  });

  it("rejects a flag other than --path", () => {
    const message = errorOf("npx skills add --force x/y");
    expect(message).toContain('"--force"');
    expect(message).toContain('"--path"');
  });

  it("rejects a URL where owner/repo belongs", () => {
    expect(errorOf("npx skills add https://github.com/x/y")).toContain("owner/repo");
  });

  it("rejects a --path that climbs out of the repository", () => {
    expect(errorOf("npx skills add x/y --path ../etc")).toContain("..");
  });
});

describe("parseSource", () => {
  it("routes a command through the command parser", () => {
    expect(parseSource("npx skills add anthropics/skills")).toMatchObject({
      kind: "github",
      owner: "anthropics",
      repo: "skills",
    });
  });

  it("reads a repository URL", () => {
    expect(parseSource("https://github.com/anthropics/skills")).toEqual({
      kind: "github",
      owner: "anthropics",
      repo: "skills",
    });
  });

  it("reads a tree URL as a ref and a subtree", () => {
    expect(parseSource("https://github.com/anthropics/skills/tree/main/skills/research")).toEqual({
      kind: "github",
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      path: "skills/research",
    });
  });

  it("reads a blob URL pointing at a SKILL.md", () => {
    expect(
      parseSource("https://github.com/anthropics/skills/blob/main/skills/research/SKILL.md"),
    ).toEqual({
      kind: "github",
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      path: "skills/research",
    });
  });

  it("treats anything else as a local folder", () => {
    expect(parseSource("~/Projects/my-skills")).toEqual({
      kind: "local",
      root: "~/Projects/my-skills",
    });
  });

  it("rejects a URL whose dot segments move it out of the tree form", () => {
    // URL parsing resolves ".." before we see it, so the link stops being a
    // tree link at all; either way it must not become a source.
    const result = parseSource("https://github.com/o/r/tree/main/../../etc");
    expect("error" in result).toBe(true);
  });

  it("rejects a link to a host other than github.com", () => {
    const result = parseSource("https://example.com/o/r");
    expect("error" in result && result.error).toContain("Only github.com");
  });
});
