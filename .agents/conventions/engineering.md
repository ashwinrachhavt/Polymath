# Engineering: readable, boring, reliable

These are standards for **new and touched code**, not a claim that the whole repository already follows them. Optimize for the next engineer opening a file without the conversation that produced it. Correctness, authorization, data integrity, and evidence outrank stylistic preferences.

## Understand before changing

- State the observable behavior and the invariant the change must preserve. Trace one real path from entry point through domain logic to storage, provider effects, and response.
- Read the owning domain README, adjacent implementation, callers, and existing tests. Treat examples as candidates to evaluate, not patterns to copy blindly.
- Prefer the established stack and local conventions. A new dependency, state manager, runtime, service, or abstraction must solve a concrete problem that the existing approach cannot solve cleanly.
- Make the smallest coherent change that satisfies the acceptance scenario. Avoid opportunistic rewrites, speculative extensibility, and new parallel paths for a behavior already owned elsewhere.

## Design and dependencies

- Keep one clear owner for each business rule and state transition. UI and transport adapt inputs and outputs; the owning domain enforces behavior; persistence and providers are explicit boundaries.
- Keep related logic close together. Split when a file mixes responsibilities, not to satisfy arbitrary line-count limits. A short, named helper should reveal a meaningful concept rather than merely forward a call.
- Prefer direct calls and ordinary language constructs over registries, factories, base classes, dependency-injection frameworks, and adapter chains for one implementation. Add indirection when it isolates a real dependency, policy boundary, or repeated variation.
- Make data flow visible: who created this value, who may change it, where it is validated, and which side effect follows? Avoid hidden mutation, surprising globals, and multiple competing sources of truth.
- Use explicit, finite states for meaningful workflow variants. Do not encode different business operations behind a collection of boolean flags or an overloaded generic function.
- Keep external I/O at identifiable boundaries; keep domain calculations pure where practical. Never hide a remote write in a getter, render, query, or read operation.
- Do not create tables, queues, caches, background jobs, or distributed components when a direct operation is sufficient. For a cache or queue, articulate the correctness and recovery contract first.
- Prefer deleting redundant code and consolidating call sites over creating new shims that keep two architectures alive. Preserve compatibility deliberately when callers or stored data still depend on it.

## Write code a human can follow

- Name functions for actions and results; name variables for domain meaning. Distinguish a proposed result from a persisted result, a requested operation from a completed one, and a source claim from a verified fact.
- Prefer a readable top-to-bottom path: validate, authorize, decide, execute, return. Use early exits for invalid states, shallow nesting, and small local scopes when they clarify the narrative.
- Favor explicit conditions and types over clever one-liners, deeply chained transformations, or generic machinery. A new reader should not need to jump across five pass-through functions to understand one operation.
- Derive types from their actual owners. Never use a cast, default value, or silent catch to manufacture certainty, identity, completion, or success. Follow [TypeScript contracts](typescript.md).
- Comments explain **why**, invariants, non-obvious failure modes, and tradeoffs; code explains **what**. Remove stale explanations. Document public contracts and surprising constraints near their owning code.
- Keep domain READMEs focused on ownership and durable invariants. Keep function signatures, schema fields, dependency versions, and implementation details in code, not duplicated in agent memory.
- Prefer consistency over personal taste. If two nearby patterns conflict, establish which is correct through behavior, tests, and current requirements before standardizing.

## Review and proof

- For bug fixes and complex behavior, write or identify a test that fails for the bug before changing the implementation when practical (red/green). Cover meaningful success and failure paths; do not weaken assertions to make a change pass.
- Execute the changed behavior, not just the type checker. For visual changes, inspect the rendered UI or run relevant browser tests; for provider flows, state what was simulated and what could not be verified.
- Review your own diff as a skeptical maintainer: unnecessary files, aliases, overgeneralization, hidden side effects, broken callers, cross-workspace access, and removed compatibility.
- Run targeted tests and repository checks appropriate to the change; [FACTORY.md](../FACTORY.md) defines evidence and reporting. Never report an unexecuted check as passed.
- In the handoff, explain **what changed, why it belongs where it does, the important data flow, what was actually verified, and what remains risky**. Prefer a link to code over a lengthy duplicated walkthrough.

### The 60-second readability test

From the entry point and owning domain, can a teammate answer: *What does this do? Who can do it? Where is the business decision? What is persisted or emitted? What happens on failure? How do I prove it works?* If not, simplify the code or add the missing explanation at the appropriate boundary.

## Influences, not copied policies

- [Ryan Waliany: managing specification entropy](https://www.edge.ceo/p/managing-ai-is-managing-entropy) — keep durable goals and approaches in guidance; leave implementation in code.
- [DHH: Rails Doctrine](https://rubyonrails.org/doctrine) — conventions, integrated systems, and readable code over gratuitous choice.
- [TanStack product tenets](https://tanstack.com/tenets) — explicit data flow, composable primitives, useful type safety.
- [T3 axioms](https://github.com/t3-oss/create-t3-app#t3-axioms) — solve real problems, adopt risk responsibly, preserve type safety.
- [Vercel React best practices](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices) — measure meaningful performance costs, especially waterfalls and bundles.
- [Simon Willison: Agentic Engineering Patterns](https://simonwillison.net/guides/agentic-engineering-patterns/) — test code, demonstrate behavior, and review agent output.
