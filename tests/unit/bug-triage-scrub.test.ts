import { describe, expect, it } from "vitest";
import { repoFile, routePattern, scrubText } from "@/domains/bug-triage/scrub";

/*
 * The repository is public: whatever survives the scrubber is published.
 * Each case pairs a realistic error string with the private part that must
 * not appear in the output, and the useful part that must.
 */

describe("scrubText", () => {
  it.each([
    ["an email", "No member for ada.lovelace+test@example.co.uk in workspace", "ada.lovelace", "No member for <email>"],
    [
      "a bearer token",
      "upstream rejected Authorization: Bearer abcDEF123456.xyz-_~",
      "abcDEF123456",
      "upstream rejected",
    ],
    ["a GitHub token", "push failed with ghp_A1b2C3d4E5f6G7h8I9j0K1l2", "ghp_A1b2", "push failed with <token>"],
    ["a fine-grained GitHub token", "token github_pat_11ABCDEFG0123456789_abcdef", "github_pat_11", "<token>"],
    ["an OpenAI-style key", "invalid key sk-proj-abc123DEF456ghi789", "sk-proj", "invalid key <token>"],
    ["an AWS key id", "credential AKIAIOSFODNN7EXAMPLE denied", "AKIAIOSFODNN7EXAMPLE", "credential"],
    ["a JWT", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N", "eyJhbGci", "jwt <token>"],
    ["a key=value secret", "config password=hunter2hunter2 api_key: zz9plural", "hunter2", "password=<redacted>"],
    ["an IPv4 address", "connect ECONNREFUSED 10.0.12.7:5432", "10.0.12.7", "ECONNREFUSED <ip>:5432"],
    ["an IPv6 address", "client 2001:db8:85a3::8a2e:370:7334 blocked", "2001:db8", "client <ip> blocked"],
    [
      "a URL with ids",
      "fetch https://polymath.example/notes/9f1c2a3b-1111-4222-8333-444455556666?q=secret failed",
      "secret",
      "fetch <url> failed",
    ],
    ["a uuid", "document 9f1c2a3b-1111-4222-8333-444455556666 not found", "9f1c2a3b", "document :id not found"],
    ["a Clerk user id", "no membership for user_2abcDEF345ghiJKL", "user_2abc", "no membership for :id"],
    [
      "query params from drizzle",
      "Failed query: select * from users where email = $1\nparams: ada@example.com,42",
      "ada@example.com",
      "params: <redacted>",
    ],
    [
      "long quoted user text",
      `Unexpected token in "My private journal entry about the meeting with Bob"`,
      "journal",
      `"<text>"`,
    ],
    ["a home directory", "ENOENT /Users/ashwin/Projects/axiom/x.ts", "ashwin", "ENOENT ~/Projects"],
  ])("removes %s", (_name, input, secret, kept) => {
    const output = scrubText(input);
    expect(output).not.toContain(secret);
    expect(output).toContain(kept);
  });

  it("keeps short identifiers that explain the error", () => {
    expect(scrubText("Cannot read properties of undefined (reading 'title')")).toBe(
      "Cannot read properties of undefined (reading 'title')",
    );
  });

  it("leaves times and line numbers alone", () => {
    expect(scrubText("timed out at 12:30:45 in file.ts:12:5")).toBe("timed out at 12:30:45 in file.ts:12:5");
  });

  it("bounds the length", () => {
    expect(scrubText("x ".repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});

describe("routePattern", () => {
  it.each([
    ["/notes/9f1c2a3b-1111-4222-8333-444455556666", "/notes/:id"],
    ["https://polymath.example/library/doc_123?tab=x#y", "/library/:id"],
    ["/projects/123/edit", "/projects/:id/edit"],
    ["/learn/My%20Private%20Topic", "/learn/:id"],
    ["/settings/api-keys", "/settings/api-keys"],
    ["/", "/"],
  ])("%s -> %s", (input, expected) => {
    expect(routePattern(input)).toBe(expected);
  });
});

describe("repoFile", () => {
  it.each([
    ["webpack-internal:///(rsc)/./src/domains/notes/queries.ts", "src/domains/notes/queries.ts"],
    ["app:///src/app/(workspace)/notes/[id]/page.tsx", "src/app/(workspace)/notes/[id]/page.tsx"],
    ["/app/src/lib/db.ts", "src/lib/db.ts"],
    ["/app/node_modules/drizzle-orm/src/pg.ts", null],
    ["/app/.next/server/chunks/123.js", null],
    [null, null],
  ])("%s -> %s", (input, expected) => {
    expect(repoFile(input)).toBe(expected);
  });
});
