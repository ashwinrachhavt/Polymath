import { describe, expect, it } from "vitest";
import { ComposioGraphqlNotQueryError, executeComposioGraphqlRead } from "@/domains/integrations/composio";
import { readLinearIssue, searchLinearIssues } from "@/domains/integrations/reads/linear";
import { TOOL_SCHEMAS } from "@/domains/integrations/tool-manifest";
import { fixtureTransport } from "../helpers/fixture-transport";

const ACCOUNT = "ca_linear";

describe("linear reads", () => {
  it("searches with the term as a variable, never in the document", async () => {
    const seen: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    const base = fixtureTransport([
      { method: "GRAPHQL", endpointPrefix: "https://api.linear.app/graphql#PolymathSearchIssues", status: 200, body: { issues: { nodes: [{ identifier: "ASH-9", title: "Nav", state: { name: "Todo" }, assignee: null, priority: 2 }] } } },
    ]);
    const transport = { ...base, graphql: async (r: Parameters<NonNullable<typeof base.graphql>>[0]) => (seen.push(r), base.graphql!(r)) };
    const term = 'x") { id } } mutation { issueDelete(id:"1")';
    const result = await searchLinearIssues(transport, { connectedAccountId: ACCOUNT, term, limit: 500 });
    expect(result.ok && result.items[0]).toMatchObject({ identifier: "ASH-9", state: "Todo", assignee: null });
    expect(seen[0].query).not.toContain("issueDelete");
    expect(seen[0].variables).toEqual({ term, first: 100 });
  });

  it("reads an issue, reports a missing one, and fails closed on a malformed body", async () => {
    const ok = fixtureTransport([
      { method: "GRAPHQL", endpointPrefix: "https://api.linear.app/graphql#PolymathReadIssue", status: 200, body: { issue: { identifier: "ASH-1", title: "T", description: "d", labels: { nodes: [{ name: "bug" }] }, comments: { nodes: [{ body: "hi", user: { name: "A" } }] } } } },
    ]);
    const read = await readLinearIssue(ok, { connectedAccountId: ACCOUNT, identifier: "ASH-1" });
    expect(read.ok && read.item.labels).toEqual(["bug"]);
    const missing = fixtureTransport([{ method: "GRAPHQL", endpointPrefix: "https://api.linear.app/graphql#PolymathReadIssue", status: 200, body: { issue: null } }]);
    expect(await readLinearIssue(missing, { connectedAccountId: ACCOUNT, identifier: "ASH-2" })).toMatchObject({ ok: false });
    const bad = fixtureTransport([{ method: "GRAPHQL", endpointPrefix: "https://api.linear.app/graphql#PolymathSearchIssues", status: 200, body: { issues: 1 } }]);
    expect(await searchLinearIssues(bad, { connectedAccountId: ACCOUNT, term: "a", limit: 5 })).toMatchObject({ ok: false, code: "malformed_response" });
  });

  it("validates identifiers", () => {
    expect(TOOL_SCHEMAS.linear_read_issue.safeParse({ identifier: "ASH-188" }).success).toBe(true);
    for (const identifier of ["ASH", "ASH-1 mutation", "../x", ""]) {
      expect(TOOL_SCHEMAS.linear_read_issue.safeParse({ identifier }).success, identifier).toBe(false);
    }
  });
});

describe("graphql transport guard", () => {
  it("refuses mutations and subscriptions before building a request", async () => {
    const call = (query: string) => executeComposioGraphqlRead({ connectedAccountId: "c", endpoint: "https://api.linear.app/graphql", query });
    await expect(call("mutation { issueDelete(id: \"1\") { success } }")).rejects.toBeInstanceOf(ComposioGraphqlNotQueryError);
    await expect(call("query { a } mutation { b }")).rejects.toBeInstanceOf(ComposioGraphqlNotQueryError);
    await expect(call("subscription { x }")).rejects.toBeInstanceOf(ComposioGraphqlNotQueryError);
  });
});
