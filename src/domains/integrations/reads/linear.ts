import { z } from "zod";
import type { Transport } from "@/domains/integrations/transport";
import type { ReadFailure } from "./github";

/*
 * Linear reads. The GraphQL documents are constants in this file; every value
 * a caller supplies travels as a variable, so no model-supplied string can
 * change the shape of the query. The transport refuses non-query documents.
 */

const ENDPOINT = "https://api.linear.app/graphql";

const SEARCH = `query PolymathSearchIssues($term: String!, $first: Int!) {
  issues(first: $first, orderBy: updatedAt, filter: { title: { containsIgnoreCase: $term } }) {
    nodes { identifier title url priority updatedAt state { name } assignee { name } }
  }
}`;

const READ = `query PolymathReadIssue($id: String!) {
  issue(id: $id) {
    identifier title description url priority updatedAt
    state { name } assignee { name } labels { nodes { name } }
    comments(first: 30) { nodes { body createdAt user { name } } }
  }
}`;

// Linear identifiers: TEAMKEY-123.
export const linearIdentifier = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/, "Use a Linear issue identifier such as ASH-188.");

const named = z.object({ name: z.string().nullable().optional() }).nullable().optional();

const summarySchema = z.object({
  identifier: z.string(),
  title: z.string(),
  url: z.string().optional(),
  priority: z.number().nullable().optional(),
  updatedAt: z.string().optional(),
  state: named,
  assignee: named,
});

const searchSchema = z.object({ issues: z.object({ nodes: z.array(summarySchema) }) });
const readSchema = z.object({
  issue: summarySchema
    .extend({
      description: z.string().nullable().optional(),
      labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).optional(),
      comments: z
        .object({ nodes: z.array(z.object({ body: z.string().nullable().optional(), createdAt: z.string().optional(), user: named })) })
        .optional(),
    })
    .nullable(),
});

function malformed(what: string): ReadFailure {
  return { ok: false, code: "malformed_response", message: `Linear returned a ${what} response this app does not recognise.` };
}

function summarise(issue: z.infer<typeof summarySchema>) {
  return {
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url ?? null,
    state: issue.state?.name ?? null,
    assignee: issue.assignee?.name ?? null,
    priority: issue.priority ?? null,
    updatedAt: issue.updatedAt ?? null,
  };
}

const clip = (text: string | null | undefined, max: number) => (text && text.length > max ? `${text.slice(0, max)}…` : (text ?? null));

export async function searchLinearIssues(
  transport: Transport,
  input: { connectedAccountId: string; term: string; limit: number },
): Promise<{ ok: true; items: ReturnType<typeof summarise>[] } | ReadFailure> {
  if (!transport.graphql) return { ok: false, code: "not_configured", message: "This transport cannot run Linear reads." };
  const response = await transport.graphql({
    connectedAccountId: input.connectedAccountId,
    endpoint: ENDPOINT,
    query: SEARCH,
    variables: { term: input.term, first: Math.min(Math.max(input.limit, 1), 100) },
  });
  if (!response.ok) return { ok: false, code: response.code, message: response.message };
  const parsed = searchSchema.safeParse(response.data);
  if (!parsed.success) return malformed("search");
  return { ok: true, items: parsed.data.issues.nodes.map(summarise) };
}

export async function readLinearIssue(
  transport: Transport,
  input: { connectedAccountId: string; identifier: string },
): Promise<
  | { ok: true; item: ReturnType<typeof summarise> & { description: string | null; labels: string[]; comments: Array<{ author: string | null; createdAt: string | null; body: string | null }> } }
  | ReadFailure
> {
  if (!transport.graphql) return { ok: false, code: "not_configured", message: "This transport cannot run Linear reads." };
  const response = await transport.graphql({
    connectedAccountId: input.connectedAccountId,
    endpoint: ENDPOINT,
    query: READ,
    variables: { id: input.identifier },
  });
  if (!response.ok) return { ok: false, code: response.code, message: response.message };
  const parsed = readSchema.safeParse(response.data);
  if (!parsed.success) return malformed("issue");
  const issue = parsed.data.issue;
  if (!issue) return { ok: false, code: "provider_error", message: `Linear has no issue ${input.identifier} visible to this connection.` };
  return {
    ok: true,
    item: {
      ...summarise(issue),
      description: clip(issue.description, 8000),
      labels: (issue.labels?.nodes ?? []).map((label) => label.name),
      comments: (issue.comments?.nodes ?? []).map((c) => ({ author: c.user?.name ?? null, createdAt: c.createdAt ?? null, body: clip(c.body, 4000) })),
    },
  };
}
