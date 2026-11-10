# Engineering principles: 35 rules for code a human can understand

**Scope:** new or changed Polymath code, not a retrospective judgment of the existing tree. **Priority:** correct behavior and safety > clear intent > low change cost > fewer lines. These are review heuristics; a flagged smell invites investigation, not automatic refactoring. Follow [FACTORY](../FACTORY.md) for scope/plan/execute/assess/resolve and the more specific [TypeScript](typescript.md), [API](api.md), [data](data.md), [frontend](frontend.md), and [agent](agents.md) rules where relevant.

## A. Solve the actual problem with minimal machinery

**01. Start from an observable outcome.** Before designing, state who needs what behavior, the acceptance example, and the important failure case. Smell: the agent begins by proposing classes, tables, or tools without tracing the user's request to an outcome. Review: can an actual scenario fail or pass?

**02. Apply YAGNI to capabilities and flexibility.** Do not add speculative modes, configuration knobs, plugin points, versioning, or future providers. Design for known requirements; defer hypothetical requirements. Review: identify the caller or acceptance scenario that needs every new option. Preserve necessary compatibility and safety even when they are not exciting features.

**03. Climb the Ponytail solution ladder.** First ask whether new code is necessary; then look for an existing domain implementation; then platform/standard-library features; then an already-installed dependency; then the smallest clear local implementation. Local conventions outrank a clever native shortcut if the native approach breaks accessibility or consistency. Review: note the first viable rung and why lower rungs failed.

**04. Prefer the smallest *complete* change, not the fewest edited lines.** Include actual callers, tests, fixtures, migrations, docs, exports, and cleanup needed to preserve a working system. One line that obscures behavior or silently breaks a consumer is not simpler. Smell: a tiny patch surrounded by stale code or disabled checks.

**05. Require a concrete reason for a dependency or subsystem.** Before adding a package, framework, cache, worker, registry, or queue, specify the measurable capability missing from existing code. Check maintenance, security, bundle size, runtime constraints, failure modes, and removal cost. Smell: installing a date picker while a house component already meets the interaction requirement.

## B. DRY, cohesion, and change locality

**06. DRY means one authoritative *decision*, not zero similar syntax.** Centralize a business invariant, policy, transformation, or contract that must evolve together. Do not mechanically deduplicate similar lines whose meanings or future changes differ. Review: would a change in one domain fact require changing both copies?

**07. Tolerate local duplication before premature generalization.** Two cases that happen to look alike can remain separate until a stable shared concept emerges. Smell: a generic utility with flags, callbacks, and branches serving two unrelated features. Review: can the helper be named in authentic domain language, rather than describing syntax?

**08. Give every invariant one owner.** A domain defines its own rules and table/query interfaces; transports, UI, and agents call that owner rather than reimplementing policy. Smell: authorization, Zettel evidence checks, or quiz grading implemented separately in a server action and an HTTP route. Review: point to the single rule that all entry points exercise.

**09. Optimize for locality of change.** A single domain behavior change should normally be implemented in one owning module and the immediately affected consumers. Smells: **shotgun surgery** (one rule spread across many files) and **divergent change** (one module edited for unrelated reasons). Review: list the files a future change would touch and why.

**10. Delete superseded paths rather than growing compatibility shells forever.** Inventory consumers, jobs, stored records, and rollout requirements, then remove redundant layers when safe. Smells: two agent runtimes with the same responsibility, unused exports, and wrappers kept “just in case.” Review: show where old callers moved; keep a deliberate compatibility path only if an actual user still needs it.

## C. Model the domain rather than just its data shapes

**11. Use one vocabulary within each bounded context.** Names in UI, operations, tests, logs, and specs should match the relevant domain's language; reconcile ambiguous terms before adding code. For Polymath, **Document, Extraction, Zettel, Evidence, Ticket, Mandate, TicketRun, and QuizAttempt** are not interchangeable. Read the owning domain README; do not invent synonym types.

**12. Draw boundaries around business ownership, not folders or technology.** Knowledge owns evidence and artifact lifecycle; Learning owns grading and recall attempts; Superagent owns admitted work and run state. A Next.js route or database table is not the domain. Smell: a shared “CommonService” that privately reaches through several unrelated domains.

**13. State invariants in prose, then enforce them at the owning boundary.** Examples: a published result cannot be inferred from an accepted task; an external receipt cannot be fabricated; a source quote must belong to the correct extraction; a cross-workspace relation must be authorized. Types, runtime checks, and database constraints may each enforce different parts; none automatically replaces the others.

**14. Represent different meanings as different concepts.** Separate source text from a verified claim, suggested knowledge from reviewed knowledge, run admission from execution, and unknown from not-found. Smells: one overloaded “status”, nullable fields with competing meanings, or a DTO whose truthfulness depends on hidden caller conventions.

**15. Make state transitions explicit and testable.** Define legal transitions and who is authorized to perform them. Keep state changes atomic and preserve evidence of retries and failures. Smell: multiple booleans such as “active/ready/succeeded/sent” that permit contradictory combinations. Review: enumerate success, failure, cancellation, and recovery.

## D. Deep modules and disciplined OOP

**16. Prefer deep modules: small interface, meaningful capability.** Hide complex validation, retries, or policy inside an owned implementation that callers can use without learning internal sequencing. Smell: a “service” with fifteen methods that only forward to helpers. Review: would removing the module force its complexity into every caller, or merely delete indirection?

**17. Treat the whole contract as the interface.** Document the few non-obvious obligations callers need: input meaning, authorization, side effects, ordering, retry/idempotency, errors, and resource limits. A TypeScript signature alone is not enough. Review: can a new caller invoke the module safely without reading its private source?

**18. Organize by reason to change, not arbitrary function length.** Keep code that serves one coherent responsibility together; split when changes come from independent policies or actors. A readable 60-line orchestration function may beat fifteen two-line helpers. Smell: files separated only to satisfy style metrics while one feature spans endless jumps.

**19. Encapsulate behavior with its state; avoid Feature Envy.** When callers repeatedly inspect another object's internals to decide its legal behavior, move that rule to the owning domain operation or object. Prefer asking an aggregate to perform a meaningful action rather than fetching its fields and reconstructing its invariant everywhere. Do not force OOP classes where a pure function is clearer.

**20. Use composition by default; inheritance must honor substitution.** Extend classes only when every subtype legitimately satisfies the parent's contract. Smells: subclasses that throw for inherited methods, override most behavior, or exist to share two utility functions. Prefer ordinary functions, composition, or discriminated unions for the shapes that actually vary.

**21. Introduce a seam for real variation or a consequential effect.** Inject clocks, provider clients, random sources, and storage at boundaries when doing so enables deterministic behavior or isolates external writes. Do not create an interface-and-adapter pair for each one-line function. Review: show a real second implementation, meaningful test fake, or external-effect boundary.

## E. Readability and code smells

**22. Name for meaning, action, and lifecycle.** Prefer “gradeQuizAttempt”, “enqueueTicketRun”, and “verifiedSourceQuote” to “handle”, “processData”, and “result”. Avoid misleading names and abbreviations that require oral tradition. Review: can a maintainer find the entry point and infer the outcome by search?

**23. Keep the happy path visible.** Arrange orchestration in the reader's expected order—parse, authenticate, authorize, decide, persist/execute, return—and use guards for exceptional cases. Avoid deeply nested control flow and hidden mutation. Review: can the main story be read top to bottom without mentally executing helpers?

**24. Extract functions for concepts, not line count.** A helper should name and isolate an actual step, invariant, or reusable behavior. Smells: chains of one-line pass-through functions, middle-man classes, and excessive jumps that hide a simple operation. Inline trivial wrappers when they add no useful contract.

**25. Comment why and document non-obvious contracts, not what the syntax says.** Explain invariants, constraints, risk, and surprising decisions near the code they govern; update stale comments when behavior changes. For subtle public interfaces, well-written documentation beats a guessing game. Smell: paragraphs narrating each assignment or no explanation for an irreversible mutation.

**26. Eliminate flag arguments, magic values, and needless navigation.** Replace opaque booleans with explicit operations or discriminated states; give domain constants and units meaningful names. Avoid “message chains” where callers depend on private object topology. Review: does a function call communicate intent without knowing positional flags and internal structure?

## F. Contracts, effects, and operational correctness

**27. Parse untrusted values once at the boundary.** TypeScript types do not validate network input, tool outputs, persisted JSON, or third-party events. Preserve a single owning schema; distinguish omitted, null, and invalid values. Smell: “as any”, parallel DTO shapes, or defaults that manufacture a valid-looking ID.

**28. Preserve precise failure semantics.** Not found, unauthorized, invalid input, provider unavailable, timeout, duplicate, and incomplete execution are different outcomes. Do not return empty arrays on arbitrary failures or represent accepted work as completed. Review: what user-visible state and internal diagnostic does each failure produce?

**29. Make writes correct under concurrency and retries.** Define transaction and idempotency boundaries, unique constraints, stable operation IDs, and recovery after uncertain provider outcomes. Smell: “check then insert” without a race-safe constraint or blindly replaying an external write after timeout. Follow [data](data.md) and [agent architecture](agents.md) conventions.

**30. Make query and cache costs visible.** Query only needed fields, scope to the tenant, avoid N+1 reads, impose bounds, and index for observed access patterns. Cache only with explicit ownership, scope, freshness, and invalidation. Smell: unbounded rows, hidden network waterfalls, or a cache used to disguise an incorrect query.

**31. Own every asynchronous effect and its lifetime.** Await promises or delegate to an explicitly durable mechanism. Bound retries, time, concurrency, and cost; clean up subscriptions, cancel stale UI work, and report unfinished operations honestly. Smell: fire-and-forget provider calls, optimistic “success” before confirmation, or a worker with no recovery story.

## G. Feedback, debugging, and review

**32. Test behavior through meaningful public seams.** Prefer a failing scenario and a minimal passing implementation when a bug or business rule permits it. Use independent expected values, exercise failure and authorization cases, and avoid tests coupled to private implementation. A mocked test that always confirms its own assumptions is not evidence.

**33. Diagnose before patching.** Reproduce the specific symptom with a runnable check; minimize the failing case, generate falsifiable hypotheses, inspect the relevant boundary, and fix the common cause. Preserve a regression test when there is a suitable test seam. Smell: changing several variables or adding retries without identifying why the operation fails.

**34. Review against two independent axes.** **Spec:** does the diff fulfill the acceptance scenario, including negative cases, without scope creep? **Standards:** does it preserve architectural ownership, human readability, security, and relevant code-smell guidance? A clean diff that solves the wrong problem fails; a feature-complete diff that adds unsound complexity also fails.

**35. Perform the 60-second maintainer handoff.** From the entry point, can a reader answer: *What does this do? Who may call it? Where is the rule? What changes in storage or the outside world? What if it fails? How was it verified?* Review every changed line for needless indirection, unrelated edits, and unsupported claims. Record the actual checks run and remaining limitations, not imagined success.

## Applying these rules without bloat

- **Before implementation:** apply 01–05, 11–17; inspect domain ownership and public seams.
- **During implementation:** apply the rules relevant to your actual diff; do not recite all 35 in every response.
- **Before handoff:** apply 06–10, 22–35 as a targeted diff review; report only consequential issues.
- **Smells are prompts for investigation.** Large methods, duplicated syntax, classes, and extra files are not automatic violations. Explain the specific change-cost, correctness, or comprehension harm before refactoring.
- **Safety is never “optional complexity.”** Authorization, validation, privacy, accessibility, loss prevention, and compatibility obligations survive aggressive simplification.
- **Keep guidance durable.** Don't paste entire third-party skills into this repository or duplicate current function signatures, schemas, and versions. Only add a durable convention after evidence of recurring failure.

## Research basis (influences, not copied rules)

- [Ponytail original skill](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md): solution ladder, YAGNI, minimum *complete* diff, preserved safeguards.
- [Matt Pocock — codebase-design](https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/SKILL.md): deep modules, narrow interfaces, locality, testable seams.
- [Matt Pocock — domain-modeling](https://github.com/mattpocock/skills/blob/main/skills/engineering/domain-modeling/SKILL.md): glossary, bounded vocabulary, real scenarios, sparse ADRs.
- [Matt Pocock — code-review](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md): separate standards/spec review and contextual Fowler smells.
- [Matt Pocock — TDD](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md) and [diagnosing-bugs](https://github.com/mattpocock/skills/blob/main/skills/engineering/diagnosing-bugs/SKILL.md): feedback loops, observable behavior, regression evidence.
- [Pragmatic Programmer DRY chapter (publisher extract)](https://media.pragprog.com/titles/tpp20/dry.pdf): eliminate duplicated knowledge/intent, not merely matching text.
- [Martin Fowler — YAGNI](https://martinfowler.com/bliki/Yagni.html), [Code Smells](https://martinfowler.com/bliki/CodeSmell.html), [Bounded Contexts](https://martinfowler.com/bliki/BoundedContext.html), and [Kent Beck's design rules](https://martinfowler.com/bliki/BeckDesignRules.html).
- [John Ousterhout — Modular Design (Stanford)](https://web.stanford.edu/~ouster/cgi-bin/cs190-winter18/lecture.php?topic=modularDesign) and [software design](https://web.stanford.edu/~ouster/cgi-bin/cs190-winter21/lecture.php?topic=bookReview).
- [DHH — Rails Doctrine](https://rubyonrails.org/doctrine), [TanStack Tenets](https://tanstack.com/tenets), [T3 Axioms](https://github.com/t3-oss/create-t3-app#t3-axioms), [Vercel React guidance](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices), [Simon Willison's agentic engineering patterns](https://simonwillison.net/guides/agentic-engineering-patterns/).
