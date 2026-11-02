/**
 * The idea chip's context payload, shared by the chat and home composers.
 * A pure function so tests can pin the contract without a server import:
 * exactly `title`, `claim` (cut to 600 characters), `tags`, and at most five
 * `{ title, relation }` links.
 */
export function ideaContextPayload(idea: {
  title: string;
  claim: string;
  tags: string[];
  links: Array<{ title: string; relation: string }>;
}): Record<string, unknown> {
  return {
    title: idea.title,
    claim: idea.claim.slice(0, 600),
    tags: idea.tags,
    links: idea.links.slice(0, 5).map((link) => ({ title: link.title, relation: link.relation })),
  };
}
