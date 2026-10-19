# agents/

Conventions every agent working in this repo reads before writing code, schema,
copy, or UI. The operator (Ashwin) drives; these files exist so the output has
one consistent taste instead of one per session.

The root `CLAUDE.md` `@`-imports **three** of these files. They are loaded by
default in every session, so they stay short. The rest are read when a task needs
them.

**Always loaded**

| File | Governs | Read it when |
|---|---|---|
| [product.md](product.md) | What Polymath is, what is decided, what is out of scope | proposing a feature, a screen, or copy |
| [coding.md](coding.md) | How code, schema, and tests are written | writing or reviewing any code |

**On demand**

| File | Governs | Read it when |
|---|---|---|
| [agent.md](agent.md) | The agent org, authority, MCP, skills, evals, and how work flows | starting a task that touches more than one file |
| [architecture.md](architecture.md) | The system map: domains, data spine, boundaries, known gaps | crossing a domain boundary or wiring a subsystem |
| [api.md](api.md) | Resource naming, routes, request and response contracts | adding or changing an endpoint |
| [frontend.md](frontend.md) | State hierarchy, reads, writes, interaction, states | touching UI behaviour |
| [design.md](design.md) | Visual and interaction language, tokens, copy | touching UI, tokens, or user-facing text |
| [reference.md](reference.md) | Commands, environment, paths, gotchas, testing | a command, variable, or trap is unfamiliar |

Precedence: `agents/*` > root `CLAUDE.md` > skill defaults. The canonical product
and architecture documents are the Notion pages under Command Center / Polymath
and `docs/axiom-product-spec.md`; these files summarise the stance for agents and
always defer to those on behaviour.

Reading order for an agent new to the repo: `README.md` → `product.md` →
`coding.md` → `architecture.md` → `agent.md` → the ticket → the one spec section
the ticket names.

## The factory

`agent.md` is the operating model: the roster, the authority rules, the six
gates with their required evidence, the ticket contract, the context protocol,
and the failure modes agents have shipped here before.

`architecture.md` and `reference.md` exist because the factory needs two things a
stance document cannot provide: an accurate map of the system as built, and a
lookup for the commands and traps that cost time when guessed.

## Naming

The product is **Polymath**. The repository, package, and documentation were
renamed from Axiom in `d9bd844`. Two filenames keep the old prefix so existing
links resolve: `docs/axiom-product-spec.md` and `docs/axiom-nextjs-neon-plan.md`.
