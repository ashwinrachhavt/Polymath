# Polymath brief: outcomes and constraints

Polymath helps a person understand information and complete work through its application and agents. A successful interaction produces a useful, attributable result or a specific, actionable explanation of what prevented completion.

- A user can distinguish accepted work, active execution, waiting for input, failure, cancellation, and completion.
- Claims about reads, writes, and external outcomes are supported by execution evidence. A permission grant is not an executed action.
- Workspace data stays within the authenticated principal's authorized scope. Background work obeys the same boundary as interactive work.
- Repeated requests and recovery do not silently duplicate external effects or charges.
- Data remains recoverable through compatible changes. Retiring a feature includes accounting for its callers and stored records.
- Engineering changes improve observable behavior, with evidence proportional to the risk. Green checks support a claim; they do not replace the claim's acceptance scenario.

The architecture audit may change product boundaries. Record those decisions explicitly rather than inferring them from absent credentials, an unavailable connector, or an unfinished screen.
