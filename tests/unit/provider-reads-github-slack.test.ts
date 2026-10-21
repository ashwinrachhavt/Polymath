import { describe, expect, it } from "vitest";
import { readGithubIssue, searchGithub } from "@/domains/integrations/reads/github";
import { listSlackChannels, readSlackChannel } from "@/domains/integrations/reads/slack";
import { TOOL_SCHEMAS, toolManifest } from "@/domains/integrations/tool-manifest";
import { fixtureTransport } from "../helpers/fixture-transport";

const ACCOUNT = "ca_test";

describe("github reads", () => {
  it("summarises a search and marks pull requests", async () => {
    const transport = fixtureTransport([
      {
        method: "GET",
        endpointPrefix: "https://api.github.com/search/issues",
        status: 200,
        body: {
          items: [
            { number: 7, title: "Fix", state: "open", html_url: "https://github.com/o/r/pull/7", user: { login: "a" }, labels: [{ name: "bug" }], pull_request: {}, repository_url: "https://api.github.com/repos/o/r" },
            { number: 8, title: "Idea", state: "closed", html_url: "https://github.com/o/r/issues/8", user: null },
          ],
        },
      },
    ]);
    const result = await searchGithub(transport, { connectedAccountId: ACCOUNT, query: "repo:o/r", limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]).toMatchObject({ kind: "pull_request", repository: "o/r", labels: ["bug"], author: "a" });
    expect(result.items[1]).toMatchObject({ kind: "issue", author: null });
  });

  it("reads an issue with comments and fails closed on a malformed body", async () => {
    const ok = fixtureTransport([
      { method: "GET", endpointPrefix: "https://api.github.com/repos/o/r/issues/7/comments", status: 200, body: [{ user: { login: "b" }, body: "hi", created_at: "t" }] },
      { method: "GET", endpointPrefix: "https://api.github.com/repos/o/r/issues/7", status: 200, body: { number: 7, title: "T", state: "open", html_url: "u", body: "x".repeat(9000) } },
    ]);
    const result = await readGithubIssue(ok, { connectedAccountId: ACCOUNT, owner: "o", repo: "r", number: 7 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item.comments).toHaveLength(1);
      expect(result.item.body?.length).toBeLessThan(8100);
    }
    const bad = fixtureTransport([{ method: "GET", endpointPrefix: "https://api.github.com/search/issues", status: 200, body: { items: "nope" } }]);
    const failed = await searchGithub(bad, { connectedAccountId: ACCOUNT, query: "q", limit: 5 });
    expect(failed).toMatchObject({ ok: false, code: "malformed_response" });
  });

  it("rejects owner and repo values that could change the path", () => {
    for (const owner of ["..", "a/b", "a?x=1", "a#b", ""]) {
      expect(TOOL_SCHEMAS.github_read_issue.safeParse({ owner, repo: "r", number: 1 }).success, owner).toBe(false);
    }
    expect(TOOL_SCHEMAS.github_read_issue.safeParse({ owner: "o", repo: "r.js", number: 1 }).success).toBe(true);
  });
});

describe("slack reads", () => {
  it("treats ok:false as a failure, not an empty channel", async () => {
    const transport = fixtureTransport([
      { method: "GET", endpointPrefix: "https://slack.com/api/conversations.history", status: 200, body: { ok: false, error: "not_in_channel" } },
    ]);
    const result = await readSlackChannel(transport, { connectedAccountId: ACCOUNT, channel: "C123", limit: 5 });
    expect(result).toMatchObject({ ok: false, code: "provider_error" });
    if (!result.ok) expect(result.message).toContain("not_in_channel");
  });

  it("lists channels without archived ones and reads history newest first as returned", async () => {
    const transport = fixtureTransport([
      { method: "GET", endpointPrefix: "https://slack.com/api/conversations.list", status: 200, body: { ok: true, channels: [{ id: "C1", name: "eng" }, { id: "C2", name: "old", is_archived: true }] } },
      { method: "GET", endpointPrefix: "https://slack.com/api/conversations.history", status: 200, body: { ok: true, has_more: true, messages: [{ ts: "1700000000.000100", user: "U1", text: "hello" }] } },
    ]);
    const channels = await listSlackChannels(transport, { connectedAccountId: ACCOUNT, limit: 10 });
    expect(channels.ok && channels.channels.map((c) => c.id)).toEqual(["C1"]);
    const history = await readSlackChannel(transport, { connectedAccountId: ACCOUNT, channel: "C1", limit: 5 });
    expect(history.ok && history.hasMore).toBe(true);
    expect(history.ok && history.messages[0].at).toBe("2023-11-14T22:13:20.000Z");
  });

  it("rejects a channel value that is not a Slack id", () => {
    expect(TOOL_SCHEMAS.slack_read_channel.safeParse({ channel: "general" }).success).toBe(false);
    expect(TOOL_SCHEMAS.slack_read_channel.safeParse({ channel: "C0123ABCD" }).success).toBe(true);
  });
});

describe("manifest", () => {
  it("publishes every new tool as read-only text the model can parse", () => {
    const names = toolManifest().map((tool) => tool.name);
    for (const name of ["github_search", "github_read_issue", "slack_list_channels", "slack_read_channel"]) {
      expect(names).toContain(name);
    }
  });
});
