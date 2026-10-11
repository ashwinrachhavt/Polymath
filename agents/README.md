# agents/

Conventions every agent working in this repo reads before writing code, schema,
copy, or UI. The operator (Ashwin) drives; these files exist so the output has
one consistent taste instead of one per session.

| File | Governs | Read it when |
|---|---|---|
| [product.md](product.md) | What Axiom is, what is already decided, what is out of scope | proposing a feature, a screen, or copy |
| [engineering.md](engineering.md) | How code, schema, and tests are written | writing or reviewing any code |
| [design.md](design.md) | Visual and interaction language | touching UI, tokens, or user-facing text |

Precedence: `agents/*` > root `CLAUDE.md` > skill defaults. The canonical
product and architecture documents are `docs/axiom-product-spec.md` and
`docs/axiom-nextjs-neon-plan.md`; these three files summarise the *stance* for
agents and always defer to those on behaviour.

No spec is added here that contradicts `docs/`. If a rule here is wrong,
fix it here — do not route around it silently.

Conventions live in this directory (the command-center precedent). They are
agent-facing context, deliberately separate from runtime prompts in
`src/domains/agents/` and from donor-repo instructions.
