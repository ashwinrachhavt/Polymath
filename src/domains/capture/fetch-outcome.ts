/*
 * What a fetch actually produced. A non-empty body is not proof the page was
 * read: Firecrawl hands back the rendered body of a 404 with `error`/`statusCode`
 * set, and recording that as acquired content puts an error page in the
 * library as if it were the article. Only `acquired` carries text.
 *
 * Pure, so the rule is testable without a provider and the handler stays a
 * writer. `text` is the same shape the handler used to build: title as a
 * markdown heading above the body, trimmed, capped at 200,000 characters.
 */

export type FetchOutcome = "acquired" | "error-page" | "empty";

export type PageFetch = {
  markdown: string;
  error?: string | null;
  statusCode?: number | null;
  title?: string | null;
};

export function classifyFetchOutcome(page: PageFetch): { outcome: FetchOutcome; text: string | null } {
  const failed = Boolean(page.error) || (page.statusCode != null && (page.statusCode < 200 || page.statusCode > 299));
  if (failed) return { outcome: "error-page", text: null };
  const body = page.markdown.trim();
  if (!body) return { outcome: "empty", text: null };
  const title = page.title ? `${page.title}\n\n` : "";
  return { outcome: "acquired", text: `${title}${body}`.slice(0, 200_000) };
}
