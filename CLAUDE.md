# Polymath

**Product name: Polymath.** The repository, package, and documentation were
renamed from Axiom in `d9bd844`. `docs/axiom-product-spec.md` and
`docs/axiom-nextjs-neon-plan.md` keep their filenames so existing links resolve;
their content uses Polymath.

Personal OS consolidating command-center, alfred, and neuralflow. This repo is
the consolidation itself — a Next.js 16 modular monolith on Vercel with Neon
Postgres + pgvector as the system of record, not a proxy layer over the donor
backends. The donor repos (`~/Projects/{command-center,alfred,neuralflow}`) are
frozen read-only references; never edit them.

## The brain — read on demand

The product, architecture, and stance documents are binding, but they are **not**
pre-loaded. Read the ones a task actually needs instead of expecting them in
context. Where two disagree, the newer `docs/` document wins; where code and docs
disagree, say so instead of silently following one.

Pinned (small, always in context):

@agents/README.md
@agents/product.md
@agents/coding.md

Read on demand — pull in only when the task touches that area:

- `agents/agent.md` — the agent org, authority rules, MCP, skills, evals, and how
  work flows: gates, roles, ticket contract, context protocol, escalation. Read
  before any multi-file task.
- `agents/architecture.md` — the system map: domains, data spine, boundaries,
  and the known gaps in what is built. Read before crossing a domain boundary.
- `agents/api.md` — resource naming, routes, request and response contracts.
- `agents/frontend.md` — state hierarchy, reads, writes, interaction, states.
- `agents/design.md` — design language, components, visual stance.
- `agents/reference.md` — commands, environment, paths, gotchas, testing.
- `docs/axiom-product-spec.md` — product behaviour, scope, user-facing contracts.
  The Notion page under Command Center / Polymath is the canonical copy; the two
  are synced by hand and can drift. Report a mismatch, do not silently pick one.
- `docs/axiom-nextjs-neon-plan.md` — architecture, data model, Next.js/Neon plan.

`docs/superpowers/specs/2026-10-10-axiom-consolidation-design.md` is an earlier
iframe-over-donor-backends approach that the Next.js/Neon plan supersedes. It is
historical; do not build from it.

Precedence: `agents/*` > this file > skill defaults.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. Route only to skills in the session's available-skills list; answer directly for quick questions or small scoped edits.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Codebase Navigation — MANDATORY

You MUST use the Serena MCP tools for code navigation (symbol search, file
outlines, finding references, symbol-level edits). They are token-efficient and
exact. Fall back to Read/Glob/Grep only for non-code files (config, docs,
frontmatter) or when Serena genuinely doesn't cover the case.

## Token discipline — always on

Context is the scarce resource. Every avoidable token is a token not spent on the
task.

- **Never read a whole file to find one thing.** Use Serena `find_symbol`,
  `get_symbols_overview`, `find_referencing_symbols`, or a targeted Grep first.
- **Do not re-read files you (or a previous tool) already read** in this session.
  Reuse what is in context.
- **Keep tool output small.** Prefer `head`/`--stat`/`git diff --stat`/counts over
  full dumps. Pipe large command output through filters.
- **Scope Bash.** Avoid `ls -R`, `cat` of large files, and recursive greps across
  `node_modules`/`.next`; target paths explicitly.
- **Batch edits.** Make one edit that changes several lines rather than many
  single-line edits to the same file.
- **Don't paste large blobs back.** Summarise; reference file paths.
- **Sub-agents for breadth.** Delegate wide searches/reads to a sub-agent so their
  intermediate output doesn't land in the main window.
- **Loaded docs are opt-in.** See "The brain — read on demand" above; don't pull
  in a long spec unless the task needs it.
- **Bash output is auto-compressed.** A `rtk` PreToolUse hook rewrites shell
  commands (e.g. `git status` → `rtk git status`) to filter output before it
  reaches you. Use shell commands for their compact form; don't fight the hook.

## Output style — terse

Write like a senior engineer, not a blog post. Token discipline applies to *your*
output too.

- No preamble, no "Great question", no restating the request, no summary of what
  you're about to do. Start with the answer or the action.
- Full sentences only where they carry meaning; prefer short imperative bullets.
- Code, commands, paths, and error text stay exact — never abbreviate those.
- No closing pleasantries or offers to help further.
- One-line status updates while working; expand only when asked.

<!-- BEGIN AWS Agent Toolkit rules -->

**help_level: HIGH**

# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context

### Terminology:

- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM
- Say "AWS Settings" when referring to management tasks at [settings.aws.com](https://settings.aws.com/) (project management, billing, team members, spend limits). Users view their actual AWS resources in the AWS Management Console.
- Say "selected Region" when referring to the user's Region — not "home Region"
- The user has a managed IAM experience. This includes a managed service control policies (SCP) and resource control policies (RCP) that govern the use of AWS. They will still need to use IAM to create policies to let services work with each other. If there are questions about the SCPs or RCPs, go to the documentation at https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html

### Constraints:

- All projects share a single AWS Region determined by the user's contact address. Resources cannot be created in other Regions
- When developing:
  - MUST create all Regional resources in the project's assigned Region
  - You CAN create AWS WAF and Cloudwatch Logs resources in us-east-1 when there are global resources (like a global WAF instance) that require a connection to dependencies in us-east-1. You should not use these for any other reason, because resources in the selected Region will provide lower cost (due to no cross-Region traffic), increased availability (due to no cross-Region traffic), and easier manageability (due to not needing to look in another Region). When you need to do an inventory of resources, you need to look in both the selected Region and us-east-1 for Cloudwatch Logs or WAF resources.
  - MUST NOT attempt to create Lambda, API Gateway, or other Regional resources in any other Region
  - MUST direct users to confirm their Region in AWS Settings > View all projects > Overview > Additional Info > Region. If the user cannot confirm their Region, check in ~/.aws/config
  - MUST NOT use Lambda@Edge — excluded from both Lambda and CloudFront
  - MUST NOT use CloudFormation StackSets — no multi-account or multi-Region deployments
  - MUST NOT attempt cross-Region actions — no cross-Region replication for DynamoDB/S3/RDS, no multi-Region KMS keys
  - MUST NOT use Route 53 cross-Region routing — geolocation, latency-based, and failover routing policies are not available
  - CloudFront is a global service and its actions ARE allowed in `us-east-1`. A user can create a CloudFront distribution pointing to their project-region Lambda function URL or API Gateway. However, Lambda and API Gateway themselves MUST NOT be created in `us-east-1` — they must be in the project Region.
  - Reduced availability in `eu-north-1` specifically: Amazon Rekognition, Amazon Textract, Amazon Personalize, AWS App Runner are not available in that Region.
- IAM permissions for human access are managed by AWS. Don't assign roles to team members unless absolutely necessary
- The user may have a spend limit if they are on the paid plan. The limit that pauses their project if it's exceeded. If resources suddenly become inaccessible, ask if they have a spend limit configured. Only project owners can modify a spend limit.
- When developing:
  - MUST ask about spend limit status if the user reports sudden "Access Denied" errors on operations that previously worked
  - MUST direct users to check spend status in AWS Settings > Billing
  - MUST check if a user has upgraded their account to the paid plan
  - MUST ask the user if they want to clean up the successfully created resources or keep them to reduce cost
- The user sets up billing, creates spend limits, and retrieves and pays invoices in AWS Settings. The user creates budgets and optimizes their costs in the AWS Billing and Cost Management console
- Not all AWS services are available. If a service isn't working, do the following:
  1. Run the command `aws freetier get-account-plan-state`
  2. If accountPlanType": "FREE", check the [Free Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-free-tier) next,
  3. If accountPlanType": "PAID", check the [Paid Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-paid-plan).
  4. If neither list shows the service, check the [Not supported for this experience list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#unsupported-services). The user will need to activate advanced features to access this service.
- Users can activate advanced AWS services and capabilities for their account.
- Before starting a task, check whether a relevant AWS skill is available. Load the skill with retrieve_skill and prefer its guidance over general knowledge.

### Help level

- help_level (required): LOW, MEDIUM, or HIGH. While a user is building, you MUST ask the user: "How much guidance would you like from me? Low (I only flag security risks), medium (I ask a couple of clarifying questions if something seems off), or high (I explain what I'm doing, suggest alternatives, and flag best practices)."

You CAN update this rule file to save a user's help_level.

Constraints for each level:

**LOW:**

- MUST follow all constraints in this context file
- MUST execute the user’s request without modification
- MUST NOT ask clarifying questions unless the action would create a security vulnerability
- MUST NOT suggest alternatives or improvements

**MEDIUM:**

- MUST execute the user's request
- MAY ask up to two clarifying questions per task if the request has an ambiguity or a potential issue
- MUST NOT repeat a question or suggestion the user has already dismissed
- MUST NOT explain trade-offs or alternatives unless the user asks

**HIGH:**

- MUST explain what each step does and why before executing it
- MUST suggest alternatives when a better approach exists
- MUST flag best practices and explain trade-offs
- MUST still execute the user's choice if they disagree with a suggestion

<!-- END AWS Agent Toolkit rules -->
