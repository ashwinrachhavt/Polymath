# Polymath agent context

Read [BRIEF.md](BRIEF.md) for desired outcomes. For any code change, also read [Engineering](conventions/engineering.md) and [FACTORY.md](FACTORY.md), then load only the task-relevant conventions below. These are requirements for new or changed code; they do not certify that existing code already complies.

| Task                                                             | Read                                             |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| General implementation, design, readability, code review         | [Engineering](conventions/engineering.md)        |
| React, Next.js, UI state, browser behavior                       | [Frontend](conventions/frontend.md)              |
| TypeScript, boundary validation, optional fields, error handling | [TypeScript](conventions/typescript.md)          |
| HTTP routes, server actions, webhooks, tool authorization        | [API and protection](conventions/api.md)         |
| Schema changes, relationships, migrations, database queries      | [Data and queries](conventions/data.md)          |
| Agent orchestration, retries, integration removal                | [Agent architecture](conventions/agents.md)      |
| New feature or substantial refactor                              | [Change specification](templates/change-spec.md) |

Load the applicable domain README and inspect its current implementation before choosing an exemplar. A source pointer helps discovery; it is not evidence that a file is correct. Historical plans describe past intent, not current implementation.

Keep enduring goals and methods here. Keep function signatures, schema definitions, configuration values, and dependency versions in their existing source files. Blog articles belong in `docs/`; these files instruct agents and should stay concise. Installed skills and generated artifacts remain ignored by Git.
