/*
 * What the agent's wiki tools check against the run's frozen policy snapshot.
 * wiki.read and wiki.lint are reads; wiki.ingest writes wiki artifacts only —
 * internal, versioned, reversible — and never touches the source documents,
 * so it is a capability on the profile like documents.search, not an action
 * proposal. The workspace comes from the verified session, never from the
 * model's arguments.
 */
export const WIKI_READ_CAPABILITY = "wiki.read";
export const WIKI_INGEST_CAPABILITY = "wiki.ingest";
export const WIKI_LINT_CAPABILITY = "wiki.lint";
