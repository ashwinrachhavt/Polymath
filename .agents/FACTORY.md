# Software Factory workflow

## Basis

This is Polymath's adaptation of Ryan Waliany's Ambiguous AI work, not a copy of an external policy:

- [Managing AI is Managing Entropy](https://www.edge.ceo/p/managing-ai-is-managing-entropy): separate durable goals (Marr L1), approaches (L2), and implementation (L3). Store implementation in code; reference examples from specifications.
- [The Tools That Scale My Team Now Scale My Agents](https://www.edge.ceo/p/the-tools-that-scale-my-team-now): shared context and domain conventions give agents a consistent basis for decisions.
- [Software Factory playbook](https://www.ryanwaliany.com/software-factory/three-levels/): scope, plan, execute, assess, resolve, with evidence of completion.

The rules below are local engineering choices. They do not imply that the author prescribes Polymath's TypeScript, HTTP, database, or testing policies.

## Execute a change

1. **Scope:** record the user-visible outcome, exclusions, acceptance scenarios, and constraints. For substantial work use the [spec template](templates/change-spec.md). Capture unresolved product or architectural decisions; continue independent work while asking for missing decisions. Existing authorization carries forward.
2. **Plan:** trace callers, persistence, authorization, failure paths, and verification. Select existing implementations only after inspecting them. Record data compatibility and migration strategy where relevant.
3. **Execute:** make coherent changes against the agreed contract. Preserve unrelated local work. Update callers before removing an interface. Keep external effects behind explicit boundaries.
4. **Assess:** run checks appropriate to changed behavior and required repository checks. Exercise meaningful failure paths. Record command, outcome, and limitations. Fix failures caused by the change; report unrelated failures accurately. Never weaken an assertion to manufacture a passing result. For code changes, inspect the diff for human readability and trace at least one relevant input-to-outcome path. For UI work, verify the rendered experience when possible rather than treating a passing typecheck as proof of usability.
5. **Resolve:** present the final diff or PR with outcomes, verification, compatibility implications, and remaining limitations. Merge or deploy only within the user's authorization. Do not add approval steps for routine work already authorized.

## Maintain the instructions

After a change, update a convention only for a durable rule or repeated failure mode. Replace stale guidance rather than accumulating contradictory instructions. Put decisions and rationale in the change spec; mark superseded decisions with a successor. Link to implementation examples instead of copying their bodies.

These Markdown rules are guidance, not automated enforcement. Consult `package.json`, `eslint.config.mjs`, `tsconfig.json`, and `.github/workflows/` for actual checks. Propose a focused lint rule or behavioral check when it can reliably enforce a rule; do not claim coverage until it runs. Documentation-only changes need link, formatting, and diff validation, not an application test suite.
