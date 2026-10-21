import { z } from "zod";
import type { Transport } from "@/domains/integrations/transport";

/*
 * GitHub reads as pure functions over a `Transport`. Every endpoint is built
 * from a fixed host; the only caller input that reaches a URL is an owner,
 * repo or number, each validated against GitHub's own name grammar and encoded
 * as a path segment, so no model-supplied string can choose the host or path.
 */

const API = "https://api.github.com";
const MAX_COMMENTS = 30;

export type ReadFailure = { ok: false; code: string; message: string };

// GitHub names: letters, digits, '.', '_', '-'. Rejecting anything else keeps
// `../` and `?` out of the path without relying on encoding alone.
export const ghName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "Use a plain GitHub owner or repository name.")
  .refine((value) => value !== "." && value !== "..", "Use a plain GitHub owner or repository name.");

const userSchema = z.object({ login: z.string() }).nullable().optional();

const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  html_url: z.string(),
  body: z.string().nullable().optional(),
  user: userSchema,
  labels: z.array(z.union([z.string(), z.object({ name: z.string().optional() })])).optional(),
  comments: z.number().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  repository_url: z.string().optional(),
  pull_request: z.unknown().optional(),
});

const searchSchema = z.object({ items: z.array(issueSchema).optional(), total_count: z.number().optional() });
const commentsSchema = z.array(
  z.object({ user: userSchema, body: z.string().nullable().optional(), created_at: z.string().optional(), html_url: z.string().optional() }),
);

function malformed(what: string): ReadFailure {
  return { ok: false, code: "malformed_response", message: `GitHub returned a ${what} response this app does not recognise.` };
}

function labelNames(labels: z.infer<typeof issueSchema>["labels"]): string[] {
  return (labels ?? []).map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean);
}

const clip = (text: string | null | undefined, max: number) => (text && text.length > max ? `${text.slice(0, max)}…` : (text ?? null));

export type GithubIssueSummary = {
  number: number;
  title: string;
  state: string;
  kind: "issue" | "pull_request";
  url: string;
  repository: string | null;
  author: string | null;
  labels: string[];
  updatedAt: string | null;
};

function summarise(issue: z.infer<typeof issueSchema>): GithubIssueSummary {
  const repository = issue.repository_url?.replace(`${API}/repos/`, "") ?? null;
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    kind: issue.pull_request ? "pull_request" : "issue",
    url: issue.html_url,
    repository,
    author: issue.user?.login ?? null,
    labels: labelNames(issue.labels),
    updatedAt: issue.updated_at ?? null,
  };
}

export async function searchGithub(
  transport: Transport,
  input: { connectedAccountId: string; query: string; limit: number },
): Promise<{ ok: true; items: GithubIssueSummary[] } | ReadFailure> {
  const response = await transport.read({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${API}/search/issues`,
    method: "GET",
    query: { q: input.query, per_page: String(Math.min(Math.max(input.limit, 1), 100)), sort: "updated", order: "desc" },
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) return { ok: false, code: response.code, message: response.message };
  const parsed = searchSchema.safeParse(response.data);
  if (!parsed.success) return malformed("search");
  return { ok: true, items: (parsed.data.items ?? []).map(summarise) };
}

export async function readGithubIssue(
  transport: Transport,
  input: { connectedAccountId: string; owner: string; repo: string; number: number },
): Promise<{ ok: true; item: GithubIssueSummary & { body: string | null; comments: Array<{ author: string | null; createdAt: string | null; body: string | null }> } } | ReadFailure> {
  const base = `${API}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.number}`;
  const headers = { Accept: "application/vnd.github+json" };
  const issue = await transport.read({ connectedAccountId: input.connectedAccountId, endpoint: base, method: "GET", headers });
  if (!issue.ok) return { ok: false, code: issue.code, message: issue.message };
  const parsedIssue = issueSchema.safeParse(issue.data);
  if (!parsedIssue.success) return malformed("issue");

  const comments = await transport.read({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${base}/comments`,
    method: "GET",
    query: { per_page: String(MAX_COMMENTS) },
    headers,
  });
  if (!comments.ok) return { ok: false, code: comments.code, message: comments.message };
  const parsedComments = commentsSchema.safeParse(comments.data);
  if (!parsedComments.success) return malformed("comments");

  return {
    ok: true,
    item: {
      ...summarise({ ...parsedIssue.data, repository_url: `${API}/repos/${input.owner}/${input.repo}` }),
      body: clip(parsedIssue.data.body, 8000),
      comments: parsedComments.data.map((comment) => ({
        author: comment.user?.login ?? null,
        createdAt: comment.created_at ?? null,
        body: clip(comment.body, 4000),
      })),
    },
  };
}
