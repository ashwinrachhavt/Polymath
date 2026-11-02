# Polymath feature map

One file per user-facing surface. The map is the maintained verification source: a proof that drives one convenient entry point is incomplete while the map lists others.

Every journey assumes the Launch steps in `../SKILL.md` are done: server up on port 3000, dev owner stamped. State the product cannot reach without a model comes from the seed helpers, never from the UI.

| Feature | File | Routes |
|---|---|---|
| Assistant conversations | conversations.md | `/polymath`, `/polymath/[runId]` |
| Reviews | reviews.md | `/reviews` |
| Notes | notes.md | `/polymath/notes` |
| Knowledge graph | knowledge-graph.md | `/polymath/graph` |
| Library and documents | library-documents.md | `/polymath/library`, `/polymath/library/[documentId]`, `/polymath/knowledge` |

When a journey fails because a precondition is missing, such as no model provider or no `BLOB_READ_WRITE_TOKEN`, record the failure and the reason in that feature's Gotchas. Never weaken the journey to make it pass.
