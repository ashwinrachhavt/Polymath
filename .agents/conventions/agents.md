# Agent architecture boundaries

- Separate admission and policy decisions from execution, tool authorization, persistence, and user-visible reporting. Each boundary has explicit inputs, outputs, and failure semantics.
- Model lifecycle transitions explicitly. Define who owns each transition, how cancellation propagates, and how recovery reconciles persisted state with external execution. Waiting, failure, and completion must be distinguishable.
- Freeze the authorized mandate for a run and validate tool calls at execution time. Record grants, advertised tools, attempted calls, and results as distinct facts. Model output cannot grant itself additional authority.
- Persist work before scheduling effects. Use receipts and stable operation identities for retries. If a provider may have completed a write before a timeout, reconcile its result before replaying; report uncertainty when reconciliation is unavailable.
- Bound retries, elapsed time, steps, spend, concurrency, and tool payloads. Escalate exhausted work into an observable state rather than leaving it permanently active.
- Separate user content and retrieved content from trusted instructions. Repository execution requires an explicit isolation and credential boundary; enabling unrestricted default shell tools is not a substitute.
- Retire an integration only after inventorying registrations, direct and indirect callers, feature flags, jobs, schemas, migrations, and retained data. Missing credentials or absence from a model's advertised tools does not establish dead code. Document replacement behavior and data retention.

Current discovery entry points are the domain READMEs in `src/domains/superagent/` and `src/domains/agents/`, plus `eve/`. Verify their claims against code. Audit actual call sites before classifying two paths as duplicate runtimes.

Acceptance scenarios should include successful completion, denied tools, provider failure, cancellation, retry after restart, duplicate delivery, and truthful rendering of incomplete work. Choose the subset affected by the change. Keep model evaluations distinct from deterministic lifecycle and authorization checks.
