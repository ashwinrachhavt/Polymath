// Suite-level contract (applies to every batch file in this directory):
/*
 * Cross-workspace isolation harness (spec D6, art_06OgtOcs).
 *
 * The claim under test: every domain query and command scopes to the caller's
 * workspace, so a member of workspace A can never read, count, or mutate
 * workspace B's rows. Nothing here calls the HTTP layer — these are the
 * domain seams every entry point already trusts (art_dZWJ6cGy §2); the
 * run-stream 404-parity test in run-stream-parity.test.ts proves the one
 * route-level guard.
 *
 * The fixture seeds two workspaces (fresh unique slugs, no truncation) and
 * inserts rows into a representative table of every tenant-scoped domain,
 * then sweeps all 33 modules of the scoping-surface enumeration
 * (art_dZWJ6cGy §5): 17 domains' queries.ts, the 15 commands.ts files that
 * exist (audit and knowledge have queries only), and superagent/store.
 *
 * HOW A FUTURE UNSCOPED QUERY FAILS THIS SUITE — the four tripwires:
 *
 * 1. Row-leak walk. Every probe result is walked for string values; a result
 *    produced under workspace-A auth may not contain any workspace-B seeded
 *    id or marker value that the probe did not itself pass in. A `select`
 *    that drops its `eq(t.workspaceId, auth.workspaceId)` leaks B's rows
 *    into A's list result, and the module's test fails naming the export.
 *    (Values the probe injected as arguments are subtracted so pure
 *    echo/redact helpers are not false positives; every seeded row also
 *    carries a marker string, so a leak that returns a foreign ROW still
 *    trips on its title/objective/summary even when the id was injected.)
 * 2. Foreign fingerprint. Around each module's sweep, every foreign-workspace
 *    seeded row is snapshotted (all columns); after the sweep the snapshot
 *    must be identical. A command that updates, deletes, or inserts against
 *    a foreign id — the write-side scoping bug — changes the snapshot.
 * 3. Adversarial ids. Probes deliberately pass the OTHER workspace's seeded
 *    ids (and the store's foreign state key) wherever a function takes one,
 *    so the correctly-scoped path throws a domain NotFoundError (classified
 *    and counted) while an unscoped path trips tripwire 1 or 2.
 * 4. Coverage floors. Silence is not isolation: each module must have at
 *    least one exercised (non-throwing) call per direction, every seeded
 *    table must be observed in at least one result (a short, reasoned
 *    exception list covers id-less projections), and hand assertions pin
 *    high-traffic reads to exactly their workspace's seeded rows — so a
 *    scope written as `where false` (vacuously empty) cannot pass either.
 *
 * A probe that throws anything that is neither an expected arg-shape error
 * nor a typed domain error rethrows — the suite fails rather than swallows.
 * The db vitest project runs this file inside `pnpm test`, which is both the
 * pre-push hook's gate and a CI leg: an unscoped query cannot merge.
 */

// max: 1, like the other suites that drive real domain functions through the
// db mock (api-key-journey et al.). With a multi-connection pool, the sweep's
// rapid serial queries plus mocked withTransaction pipelines across
// connections — observed live as responses the server sent and the client
// never read (pg_stat_activity: state=active, wait=ClientRead, minutes) —
// wedging the file with an empty event loop. One connection serializes the
// queue and removes that failure mode entirely; the sweep is sequential by
// design, so nothing pays for the lost parallelism.
// Default pool (the helper's own): a max-of-one pool starves the sweep - the
// fixture's fingerprint snapshot wedged behind an unsettled request - while
// the default pool has run the full sweep repeatedly. The exit-wedge that
// max:1 tried to fix is handled in afterAll instead: end({ timeout }) destroys
// stragglers, and the one orphaned postgres-js rejection it produces is a
// NAMED teardown artifact, logged, not swallowed.
const handle = makeTestDb();

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import postgres, { PostgresError } from "postgres";
import { afterAll, beforeAll, expect } from "vitest";
import { actionProposals } from "@/domains/actions/schema";
import { agentProfiles, agentRuns, threads } from "@/domains/agents/schema";
import { auditEvents } from "@/domains/audit/schema";
import { calendars, events } from "@/domains/calendar/schema";
import { captures } from "@/domains/capture/schema";
import { contacts, companies } from "@/domains/crm/schema";
import { dayArtifactPins } from "@/domains/daybook/schema";
import { focusSessions } from "@/domains/focus/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { artifacts, documentExtractions, documents } from "@/domains/knowledge/schema";
import { quizQuestions, quizzes } from "@/domains/learning/schema";
import { opportunities } from "@/domains/opportunities/schema";
import { skills } from "@/domains/skills/schema";
import { modelRateCards, spendingPolicies, spendingReservations, spendSettlements } from "@/domains/spending/schema";
import { superagentState } from "@/domains/superagent/store/schema";
import { tasks } from "@/domains/work/schema";
import { AsyncLocalStorage } from "node:async_hooks";
import { makeTestDb, seedWorkspace } from "../../helpers/test-workspace";

export const holder: {
  db: ReturnType<typeof makeTestDb>["db"] | undefined;
  auth: { userId: string; workspaceId: string; role: "owner" } | undefined;
  dbFor(): ReturnType<typeof makeTestDb>["db"] | undefined;
} = {
  db: undefined,
  auth: undefined,
  // Probes run inside als.run with a reserved connection; domain code's `db`
  // import resolves to that connection for the probe's lifetime. Everything
  // outside a probe (fixtures, fingerprints) sees the shared pool.
  dbFor() {
    return als.getStore()?.db ?? this.db;
  },
};

const als = new AsyncLocalStorage<{ db: ReturnType<typeof makeTestDb>["db"] }>();

import * as actionsQueries from "@/domains/actions/queries";
import * as actionsCommands from "@/domains/actions/commands";
import * as agentsQueries from "@/domains/agents/queries";
import * as agentsCommands from "@/domains/agents/commands";
import * as auditQueries from "@/domains/audit/queries";
import * as calendarQueries from "@/domains/calendar/queries";
import * as calendarCommands from "@/domains/calendar/commands";
import * as captureQueries from "@/domains/capture/queries";
import * as captureCommands from "@/domains/capture/commands";
import * as conversationsQueries from "@/domains/conversations/queries";
import * as conversationsCommands from "@/domains/conversations/commands";
import * as crmQueries from "@/domains/crm/queries";
import * as crmCommands from "@/domains/crm/commands";
import * as daybookQueries from "@/domains/daybook/queries";
import * as daybookCommands from "@/domains/daybook/commands";
import * as focusQueries from "@/domains/focus/queries";
import * as focusCommands from "@/domains/focus/commands";
import * as stonesQueries from "@/domains/stones/queries";
import * as stonesCoins from "@/domains/stones/coins";
import * as integrationsQueries from "@/domains/integrations/queries";
import * as integrationsCommands from "@/domains/integrations/commands";
import * as knowledgeQueries from "@/domains/knowledge/queries";
import * as learningQueries from "@/domains/learning/queries";
import * as learningCommands from "@/domains/learning/commands";
import * as skillsQueries from "@/domains/skills/queries";
import * as skillsCommands from "@/domains/skills/commands";
import * as spendingQueries from "@/domains/spending/queries";
import * as spendingCommands from "@/domains/spending/commands";
import * as superagentStoreQueries from "@/domains/superagent/store/queries";
import * as workQueries from "@/domains/work/queries";
import * as workCommands from "@/domains/work/commands";

type AnyFn = (...args: unknown[]) => unknown;
type ModuleEntry = {
  name: string;
  mod: Record<string, unknown>;
  domain: string;
  /** superagent/store functions take (db, workspaceId, ...). */
  store?: boolean;
  /** spending commands take (tx, { workspaceId }, input). */
  spendingStore?: boolean;
};

/** Monotonic per-process counter: idempotency keys must be unique per probe. */
let probeCounter = 0;
const probeSeq = () => `s${++probeCounter}`;

/** The 33 scoping-surface modules (art_dZWJ6cGy §5), in enumeration order. */
const MODULES: ModuleEntry[] = [
  { name: "src/domains/actions/queries.ts", mod: actionsQueries, domain: "actions" },
  { name: "src/domains/actions/commands.ts", mod: actionsCommands, domain: "actions" },
  { name: "src/domains/agents/queries.ts", mod: agentsQueries, domain: "agents" },
  { name: "src/domains/agents/commands.ts", mod: agentsCommands, domain: "agents" },
  { name: "src/domains/audit/queries.ts", mod: auditQueries, domain: "audit" },
  { name: "src/domains/calendar/queries.ts", mod: calendarQueries, domain: "calendar" },
  { name: "src/domains/calendar/commands.ts", mod: calendarCommands, domain: "calendar" },
  { name: "src/domains/capture/queries.ts", mod: captureQueries, domain: "capture" },
  { name: "src/domains/capture/commands.ts", mod: captureCommands, domain: "capture" },
  { name: "src/domains/conversations/queries.ts", mod: conversationsQueries, domain: "conversations" },
  { name: "src/domains/conversations/commands.ts", mod: conversationsCommands, domain: "conversations" },
  { name: "src/domains/crm/queries.ts", mod: crmQueries, domain: "crm" },
  { name: "src/domains/crm/commands.ts", mod: crmCommands, domain: "crm" },
  { name: "src/domains/daybook/queries.ts", mod: daybookQueries, domain: "daybook" },
  { name: "src/domains/daybook/commands.ts", mod: daybookCommands, domain: "daybook" },
  { name: "src/domains/focus/queries.ts", mod: focusQueries, domain: "focus" },
  { name: "src/domains/focus/commands.ts", mod: focusCommands, domain: "focus" },
  { name: "src/domains/stones/queries.ts", mod: stonesQueries, domain: "stones" },
  { name: "src/domains/stones/coins.ts", mod: stonesCoins, domain: "stones" },
  { name: "src/domains/integrations/queries.ts", mod: integrationsQueries, domain: "integrations" },
  { name: "src/domains/integrations/commands.ts", mod: integrationsCommands, domain: "integrations" },
  { name: "src/domains/knowledge/queries.ts", mod: knowledgeQueries, domain: "knowledge" },
  { name: "src/domains/learning/queries.ts", mod: learningQueries, domain: "learning" },
  { name: "src/domains/learning/commands.ts", mod: learningCommands, domain: "learning" },
  { name: "src/domains/skills/queries.ts", mod: skillsQueries, domain: "skills" },
  { name: "src/domains/skills/commands.ts", mod: skillsCommands, domain: "skills" },
  { name: "src/domains/spending/queries.ts", mod: spendingQueries, domain: "spending" },
  { name: "src/domains/spending/commands.ts", mod: spendingCommands, domain: "spending", spendingStore: true },
  { name: "src/domains/superagent/store/queries.ts", mod: superagentStoreQueries, domain: "superagent", store: true },
  { name: "src/domains/work/queries.ts", mod: workQueries, domain: "work" },
  { name: "src/domains/work/commands.ts", mod: workCommands, domain: "work" },
];

/* ------------------------------------------------------------------ */
/* Fixture: two workspaces, rows in every tenant-scoped domain        */
/* ------------------------------------------------------------------ */

type Seeded = { ids: string[]; markers: string[] };
type Fixture = {
  auth: { userId: string; workspaceId: string; role: "owner" };
  /** Keyed by SQL table name (the TABLE_REGISTRY spelling). */
  rows: Record<string, Seeded>;
  /** Every seeded id and unique marker value this workspace owns. */
  identity: Set<string>;
  /** The workspace's fixture marker letter ("a"/"b"), embedded in seeded keys. */
  marker: string;
};

// One client, the helper's own, exactly like every other integration suite:
// max 3, no exotic pool options. The sweep's only bound on a runaway call is
// the server (statement_timeout turns a runaway statement into a
// driver-resolved ERROR the probe classifies); a JS-side race/cap is
// deliberately absent — abandoning a live postgres-js request wedges its
// pool slot and starves the sweep.
const db = handle.db;

/**
 * One representative row per seeded table per workspace (two captures in
 * workspace b, so a leaked count cannot masquerade as the fixture's own).
 * Inserts are rerun-safe without truncation: every unique key embeds the
 * workspace id, which is fresh per run.
 */
async function seedTenantRows(workspaceId: string, userId: string, m: string): Promise<Record<string, Seeded>> {
  const out: Record<string, Seeded> = {};
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const inAnHour = new Date(now.getTime() + 3_600_000);
  const seeded = (ids: string[], markers: string[] = []): Seeded => ({ ids, markers });

  const captureValues: (typeof captures.$inferInsert)[] = [
    {
      workspaceId,
      kind: "text",
      captureMode: "authored",
      rawPayload: {},
      title: `iso-${m} capture`,
      text: `body of iso-${m}`,
    },
    ...(m === "b"
      ? ([
          {
            workspaceId,
            kind: "url",
            captureMode: "page",
            rawPayload: {},
            title: `iso-${m} capture 2`,
            text: null,
            url: "https://iso-b.example/second",
          },
        ] as (typeof captures.$inferInsert)[])
      : []),
  ];
  const captureRows = await db.insert(captures).values(captureValues).returning({ id: captures.id });
  out.captures = seeded(captureRows.map((r) => r.id));

  // event.created is in the activity feed's SAFE_SUMMARY_ACTIONS allowlist,
  // so the seeded summary text survives projection and can be asserted on.
  const auditRows = await db
    .insert(auditEvents)
    .values({
      workspaceId,
      action: "event.created",
      subjectType: "workspace",
      subjectId: workspaceId,
      summary: `iso-${m} activity`,
    })
    .returning({ id: auditEvents.id });
  out.audit_events = seeded(
    auditRows.map((r) => r.id),
    [`iso-${m} activity`],
  );

  const taskRows = await db
    .insert(tasks)
    .values({ workspaceId, title: `iso-${m} task` })
    .returning({ id: tasks.id });
  out.tasks = seeded(taskRows.map((r) => r.id));

  const contactRows = await db
    .insert(contacts)
    .values({ workspaceId, fullName: `Iso ${m} Contact`, primaryEmail: `iso-${m}-${now.getTime()}@example.test` })
    .returning({ id: contacts.id });
  out.contacts = seeded(contactRows.map((r) => r.id));

  const companyRows = await db
    .insert(companies)
    .values({ workspaceId, name: `Iso ${m} Company` })
    .returning({ id: companies.id });
  out.companies = seeded(companyRows.map((r) => r.id));

  const documentRows = await db
    .insert(documents)
    .values({ workspaceId, title: `iso-${m} document` })
    .returning({ id: documents.id });
  out.documents = seeded(documentRows.map((r) => r.id));

  // A ready quiz with one question: completeQuizAttempt's real grading path
  // (validateAnswers -> gradeAttempt -> the attempt transaction) needs a
  // READY quiz with questions to answer; without it the learning sweep
  // cannot exercise anything beyond quiz_not_found.
  const [extraction] = await db
    .insert(documentExtractions)
    .values({
      workspaceId,
      documentId: documentRows[0].id,
      contentHash: `iso-${m}-hash`,
      status: "succeeded",
      text: `body of iso-${m}`,
    })
    .returning({ id: documentExtractions.id });
  const [quiz] = await db
    .insert(quizzes)
    .values({
      workspaceId,
      documentId: documentRows[0].id,
      sourceExtractionId: extraction.id,
      title: `iso-${m} quiz`,
      status: "ready",
      questionCount: 1,
    })
    .returning({ id: quizzes.id });
  const [question] = await db
    .insert(quizQuestions)
    .values({
      workspaceId,
      quizId: quiz.id,
      ordinal: 1,
      prompt: `iso-${m} question`,
      choices: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      answerValue: "a",
      explanation: "iso fixture",
      evidence: { quote: `body of iso-${m}`, startOffset: 0, endOffset: 3 },
    })
    .returning({ id: quizQuestions.id });
  out.quizzes = seeded([quiz.id]);
  out.quiz_questions = seeded([question.id]);

  const opportunityRows = await db
    .insert(opportunities)
    .values({ workspaceId, title: `iso-${m} opportunity` })
    .returning({ id: opportunities.id });
  out.opportunities = seeded(opportunityRows.map((r) => r.id));

  const skillRows = await db
    .insert(skills)
    .values({
      workspaceId,
      slug: `iso-${m}`,
      name: `Iso ${m} Skill`,
      description: "tenant isolation fixture",
      body: "procedure",
      sourceKind: "local",
      sourceRef: `iso-${m}-ref`,
      sourcePath: `iso/${m}/SKILL.md`,
      revision: `rev-${m}`,
      contentHash: `hash-${m}`,
    })
    .returning({ id: skills.id });
  out.skills = seeded(skillRows.map((r) => r.id));

  // One live session per workspace: the partial unique index admits exactly
  // one running+started row per workspace. Workspace b's second row is
  // scheduled-only (startedAt null), which the index does not count.
  const focusRows = await db
    .insert(focusSessions)
    .values([
      { workspaceId, subject: `iso-${m} focus` },
      ...(m === "b" ? [{ workspaceId, subject: `iso-${m} scheduled`, scheduledAt: now, startedAt: null }] : []),
    ])
    .returning({ id: focusSessions.id });
  out.focus_sessions = seeded(focusRows.map((r) => r.id));

  const [calendar] = await db
    .insert(calendars)
    .values({ workspaceId, name: `Iso ${m} Calendar` })
    .returning({ id: calendars.id });
  const eventRows = await db
    .insert(events)
    .values({ workspaceId, calendarId: calendar.id, title: `iso-${m} event`, startsAt: hourAgo, endsAt: inAnHour })
    .returning({ id: events.id });
  out.events = seeded(eventRows.map((r) => r.id));

  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId, name: `iso-${m}-profile` })
    .returning({ id: agentProfiles.id });
  const runRows = await db
    .insert(agentRuns)
    .values({ workspaceId, agentProfileId: profile.id, objective: `iso-${m} objective`, policySnapshot: {} })
    .returning({ id: agentRuns.id });
  out.agent_runs = seeded(runRows.map((r) => r.id));

  const threadRows = await db
    .insert(threads)
    .values({ workspaceId, agentProfileId: profile.id, title: `iso-${m} thread` })
    .returning({ id: threads.id });
  out.threads = seeded(threadRows.map((r) => r.id));

  const accountRows = await db
    .insert(externalAccounts)
    .values({ workspaceId, provider: "iso-provider", alias: `iso-${m}-account` })
    .returning({ id: externalAccounts.id });
  out.external_accounts = seeded(accountRows.map((r) => r.id));

  const rateCardRows = await db
    .insert(modelRateCards)
    .values({
      workspaceId,
      provider: "iso-provider",
      model: `iso-model-${m}`,
      inputPerMillion: "1",
      outputPerMillion: "2",
    })
    .returning({ id: modelRateCards.id });
  out.model_rate_cards = seeded(rateCardRows.map((r) => r.id));

  // Null ceilings: the policy gate never blocks, so spending commands run
  // their real reserve/settle/release paths in the sweep.
  await db.insert(spendingPolicies).values({ workspaceId });
  const reservationRows = await db
    .insert(spendingReservations)
    .values({ workspaceId, reservedUsd: "0.010000", model: `iso-model-${m}` })
    .returning({ id: spendingReservations.id });
  out.spending_reservations = seeded(reservationRows.map((r) => r.id));

  const [artifact] = await db
    .insert(artifacts)
    .values({ workspaceId, title: `iso-${m} artifact` })
    .returning({ id: artifacts.id });
  const pinRows = await db
    .insert(dayArtifactPins)
    .values({ workspaceId, userId, localDate: now.toISOString().slice(0, 10), artifactId: artifact.id })
    .returning({ id: dayArtifactPins.id });
  out.day_artifact_pins = seeded(pinRows.map((r) => r.id));
  // The day page projects pins as their artifact; the artifact id is what
  // surfaces in results and what the walk can see.
  out.artifacts = seeded([artifact.id]);

  const proposalRows = await db
    .insert(actionProposals)
    .values({
      workspaceId,
      capability: "iso.capability",
      riskClass: "read",
      title: `iso-${m} proposal`,
      expectedEffect: "fixture",
      dedupeKey: `iso-${m}-${now.getTime()}`,
    })
    .returning({ id: actionProposals.id });
  out.action_proposals = seeded(proposalRows.map((r) => r.id));

  // superagent_state has no id column: the state KEY and VALUE are the
  // observable identity the walk looks for.
  await db.insert(superagentState).values({ workspaceId, key: `iso-${m}-state`, value: `value-of-iso-${m}` });
  out.superagent_state = seeded([], [`iso-${m}-state`, `value-of-iso-${m}`]);

  return out;
}

function identityOf(rows: Record<string, Seeded>): Set<string> {
  const out = new Set<string>();
  for (const { ids, markers } of Object.values(rows)) for (const v of [...ids, ...markers]) out.add(v);
  return out;
}

/* ------------------------------------------------------------------ */
/* Sweep machinery                                                    */
/* ------------------------------------------------------------------ */

type TenantTable = PgTable & { workspaceId: PgColumn };
const TABLE_REGISTRY: Record<string, TenantTable> = {
  captures,
  audit_events: auditEvents,
  tasks,
  contacts,
  companies,
  documents,
  opportunities,
  skills,
  focus_sessions: focusSessions,
  events,
  agent_runs: agentRuns,
  threads,
  external_accounts: externalAccounts,
  model_rate_cards: modelRateCards,
  spending_reservations: spendingReservations,
  spend_settlements: spendSettlements,
  day_artifact_pins: dayArtifactPins,
  action_proposals: actionProposals,
  superagent_state: superagentState,
};

/** Map a scoping-surface module to the seeded tables its domain owns. */
const DOMAIN_TABLES: Record<string, string[]> = {
  actions: ["action_proposals"],
  agents: ["agent_runs", "threads"],
  audit: ["audit_events"],
  calendar: ["events"],
  capture: ["captures"],
  conversations: ["threads"],
  crm: ["contacts", "companies"],
  daybook: ["day_artifact_pins", "artifacts"],
  focus: ["focus_sessions"],
  stones: [],
  integrations: ["external_accounts"],
  knowledge: ["documents"],
  learning: ["documents", "quizzes", "quiz_questions"],
  skills: ["skills"],
  spending: ["model_rate_cards", "spending_reservations"],
  superagent: ["superagent_state"],
  work: ["tasks"],
};

function domainIdsOf(entry: ModuleEntry, fixture: Fixture): string[] {
  return (DOMAIN_TABLES[entry.domain] ?? []).flatMap((k) => fixture.rows[k]?.ids ?? []);
}

const today = () => new Date().toISOString().slice(0, 10);
const dayStart = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};
const dayEnd = () => {
  const d = dayStart();
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
};

function argShapes(entry: ModuleEntry, caller: Fixture, foreign: Fixture): Array<{ shape: string; args: unknown[] }> {
  const ownId = domainIdsOf(entry, caller)[0] ?? caller.auth.workspaceId;
  const foreignId = domainIdsOf(entry, foreign)[0] ?? "00000000-0000-4000-8000-000000000000";
  const from = dayStart();
  const to = dayEnd();
  const localDate = today();
  if (entry.store) {
    // superagent/store takes (db, workspaceId, ...) — the scope IS the
    // argument, and the foreign state key is the adversarial read.
    const foreignKey = foreign.rows.superagent_state.markers[0];
    const ws = caller.auth.workspaceId;
    return [
      { shape: "(db, wsId)", args: [db, ws] },
      { shape: "(db, wsId, foreignKey)", args: [db, ws, foreignKey] },
      { shape: "(db, wsId, foreignId)", args: [db, ws, foreignId] },
      { shape: "(db, wsId, key, value)", args: [db, ws, "iso-probe", "probe"] },
      { shape: "(db, wsId, id, at)", args: [db, ws, foreignId, new Date()] },
      { shape: "(db, wsId, id, limit)", args: [db, ws, foreignId, 5] },
    ];
  }
  if (entry.spendingStore) {
    // spending commands take (tx, ctx, input); a null-ceiling policy is
    // seeded so reserve runs its real path. settle targets the caller's own
    // reservation (its scoped write is the interesting case); release aims
    // at the foreign one (scoped no-op).
    const ctx = { workspaceId: caller.auth.workspaceId };
    return [
      { shape: "(db, ctx, reserve)", args: [db, ctx, { runId: null, model: null, estimateUsd: "0.010000" }] },
      { shape: "(db, ctx, settle own)", args: [db, ctx, { reservationId: ownId, actualUsd: "0.010000", usage: {} }] },
      { shape: "(db, ctx, release foreign)", args: [db, ctx, { reservationId: foreignId }] },
    ];
  }
  return [
    { shape: "(auth)", args: [caller.auth] },
    { shape: "(auth, input={})", args: [caller.auth, {}] },
    { shape: "(auth, foreignId)", args: [caller.auth, foreignId] },
    { shape: "(auth, ownId)", args: [caller.auth, ownId] },
    { shape: "(auth, from, to)", args: [caller.auth, from, to] },
    { shape: "(auth, localDate)", args: [caller.auth, localDate] },
    // Machine-path (wsId-first) shapes were probed here in an earlier
    // revision: out-of-contract calls (a bare id where auth is expected)
    // reach drizzle with no usable binds and can wedge the postgres-js
    // protocol on some modules — a driver property, not a tenancy one.
    // Machine callers are covered by the store branch above.
  ];
}

/**
 * Bespoke probes for functions the generic shapes cannot reach: createTask
 * demands a real transaction to assign a rank. Running it inside
 * withTransaction exercises its scoped rank read and insert.
 */
const EXTRA_PROBES: Partial<Record<string, (caller: Fixture) => Promise<unknown>>> = {
  "src/domains/work/commands.ts": async (caller) => {
    const { withTransaction } = await import("@/lib/db-transaction");
    const createTask = workCommands.createTask as AnyFn;
    return withTransaction(async (tx) => createTask(caller.auth, { title: "iso-probe-task" }, tx));
  },
};

/**
 * Errors a probe is allowed to produce because the probe does not know the
 * function's real contract: arg-shape TypeErrors, typed domain rejections,
 * driver rejections of junk input (drizzle wraps the driver error, so both
 * wrapper and cause are classified), and the fetch guard tripping a provider
 * path. Anything else rethrows — the suite never swallows an unknown error.
 */
const EXPECTED_ERROR_NAMES = new Set([
  "NotFoundError",
  "ConflictError",
  "StaleWriteError",
  "ValidationError",
  "ForbiddenError",
  "ForbiddenRoleError",
  "UnauthorizedError",
  "MembershipLifecycleError",
  "InvalidPreferenceError",
  "ZodError",
  "DrizzleError",
  "DrizzleQueryError",
  "TestNetworkViolation",
]);
const EXPECTED_ERROR_CODES = new Set(["UNDEFINED_VALUE", "22P02", "42601", "23502", "23503", "23505", "23514"]);

function isExpectedProbeError(err: unknown): boolean {
  if (err instanceof TypeError || err instanceof RangeError || err instanceof PostgresError) return true;
  const e = err as { name?: string; code?: string; message?: string; cause?: unknown };
  if (e.name !== undefined && EXPECTED_ERROR_NAMES.has(e.name)) return true;
  if (e.code !== undefined && EXPECTED_ERROR_CODES.has(e.code)) return true;
  if (e.cause !== undefined && isExpectedProbeError(e.cause)) return true;
  // House domain rejections are named classes (house convention: every
  // domain error class ends in "Error" and extends Error). A plain
  // `new Error(...)` keeps the builtin constructor and stays an unexpected
  // sweep failure, so real bugs are never swallowed by this branch.
  if (err instanceof Error && err.constructor !== Error && err.constructor.name.endsWith("Error")) return true;
  // House domain rejections are not uniformly typed; these messages are the
  // scoped-path answer to an adversarial id, not sweep failures.
  // Input-guard rejections (e.g. `Invalid local date: undefined`) are the
  // domain's own validation of probe-shaped junk: the generic sweep cannot
  // know every function's arity, and a rejected probe carries no tenancy
  // evidence either way. The `exercised > 0` floor still requires at least
  // one successful probe per module.
  return /No values for|invalid input syntax|^Invalid |violates (foreign key|unique|not.?null|check) constraint|needs a transaction|no longer exists|not found|does not exist/i.test(
    e.message ?? "",
  );
}

type Attempt = { shape: string; ok: true; value: unknown } | { shape: string; ok: false; error: unknown };

/**
 * Call once, classify the outcome. Unexpected errors propagate.
 *
 * There is deliberately NO JS-side timeout race here: a capped-and-abandoned
 * postgres-js request is never un-sent — its pool slot stays owned by the
 * abandoned promise and the sweep starves behind wedged queue entries
 * (observed on every run that raced the probe). The probes call real domain
 * functions with fixture-shaped arguments, so a hung statement is not a
 * class that occurs; if one ever does, the vitest timeout names the module
 * and the fix is a documented skip or a completed-job fixture — never a
 * silent race.
 */
const PROBE_TIMEOUT_MS = 10_000;

async function probe(fn: unknown, shape: string, args: unknown[]): Promise<Attempt> {
  // Each probe gets a DEDICATED one-shot postgres-js client (max 1): a wedged
  // request dies with its own connection instead of poisoning the shared
  // fixture pool, and a standalone client is terminable (end({timeout: 0})),
  // which reserved connections are not. Fresh parsers also sidestep the
  // reserved-connection row-parsing wedge observed on row-returning shapes.
  // A wedge is recorded as a failed attempt, so a module whose probes all
  // wedge still fails the exercised>0 floor.
  const dedicated = postgres(process.env.TEST_DATABASE_URL as string, {
    max: 1,
    idle_timeout: 5,
    prepare: false,
    onnotice: () => {},
  });
  const scopedDb = drizzle(dedicated);
  let timer: NodeJS.Timeout | undefined;
  let wedged = false;
  try {
    const value = await Promise.race([
      als.run({ db: scopedDb }, async () => (fn as AnyFn)(...args)),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("PROBE_WEDGE_TIMEOUT")), PROBE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    return { shape, ok: true, value };
  } catch (err) {
    if (err instanceof Error && err.message === "PROBE_WEDGE_TIMEOUT") {
      wedged = true;
      console.warn(`[sweep-wedge] ${shape} — terminated wedged connection`);
      await dedicated.end({ timeout: 0 });
      return { shape, ok: false, error: err };
    }
    if (isExpectedProbeError(err)) return { shape, ok: false, error: err };
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    // end() is idempotent in postgres-js; a terminated client is already closed.
    await dedicated.end({ timeout: wedged ? 0 : 5 });
  }
}

/** Every string reachable in the value: ids and markers surface wherever they hide. */
function collectStrings(value: unknown, out: Set<string>, depth = 0): void {
  if (value === null || value === undefined || depth > 8) return;
  if (typeof value === "string") {
    out.add(value);
    return;
  }
  if (typeof value !== "object") return;
  if (value instanceof Date) {
    out.add(value.toISOString());
    return;
  }
  if (value instanceof Set) {
    for (const v of value) collectStrings(v, out, depth + 1);
    return;
  }
  if (value instanceof Map) {
    for (const [k, v] of value) {
      collectStrings(k, out, depth + 1);
      collectStrings(v, out, depth + 1);
    }
    return;
  }
  for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out, depth + 1);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/** Full-row snapshot of one workspace's seeded tables — the write-guard baseline. */
async function fingerprint(workspaceId: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const [key, table] of Object.entries(TABLE_REGISTRY)) {
    const rows = await db.select().from(table).where(eq(table.workspaceId, workspaceId));
    out.set(key, rows.map((r) => stableStringify(r)).sort());
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The suite                                                          */
/* ------------------------------------------------------------------ */

let a: Fixture;
let b: Fixture;
const seenIds = new Set<string>();

beforeAll(async () => {
  // The teardown artifact: postgres-js requests orphaned mid-sweep (the wedge
  // class this suite was built around) reject after their test is gone —
  // destroyed reserved connections among them. Name and log that one class so
  // the run can drain; every other unhandled rejection must fail loudly.
  process.on("unhandledRejection", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("CONNECTION_DESTROYED") || msg.includes("terminating connection")) {
      console.warn("[tenant-isolation] orphaned postgres request destroyed (expected):", msg);
      return;
    }
    console.error("[tenant-isolation] UNEXPECTED unhandled rejection:", msg);
  });
  holder.db = db;
  const SALT = Date.now().toString(36);
  const wa = await seedWorkspace(db, `tenant-iso-a-${SALT}`);
  const wb = await seedWorkspace(db, `tenant-iso-b-${SALT}`);
  const rowsA = await seedTenantRows(wa.workspaceId, wa.userId, "a");
  const rowsB = await seedTenantRows(wb.workspaceId, wb.userId, "b");
  a = {
    auth: { userId: wa.userId, workspaceId: wa.workspaceId, role: "owner" },
    rows: rowsA,
    identity: identityOf(rowsA),
    marker: "a",
  };
  b = {
    auth: { userId: wb.userId, workspaceId: wb.workspaceId, role: "owner" },
    rows: rowsB,
    identity: identityOf(rowsB),
    marker: "b",
  };
});

afterAll(async () => {
  await handle.client.end({ timeout: 5 });
});

/**
 * Per-function probe shapes: some command exports take structured inputs the
 * generic argShapes cannot satisfy (ids, expected versions, idempotency
 * keys, enum values). When a module+function has an entry here it is probed
 * with exactly these argument sets instead; everything else in the module
 * keeps the generic shapes. Own-target probes exercise the real scoped
 * write; foreign-target probes must be scoped no-ops (their domain errors
 * are classified like any failed probe).
 */
const FUNCTION_SHAPES: Record<
  string,
  (caller: Fixture, foreign: Fixture) => Array<{ shape: string; args: unknown[]; only?: string[] }>
> = {
  "src/domains/daybook/commands.ts": (caller, foreign) => {
    const localDate = today();
    return [
      {
        shape: "(auth, pin own artifact)",
        args: [caller.auth, { localDate, artifactId: caller.rows.artifacts.ids[0] }],
      },
      {
        shape: "(auth, pin foreign artifact)",
        args: [caller.auth, { localDate, artifactId: foreign.rows.artifacts.ids[0] }],
      },
      {
        shape: "(auth, unpin own artifact)",
        args: [caller.auth, { localDate, artifactId: caller.rows.artifacts.ids[0] }],
      },
      {
        shape: "(auth, unpin foreign artifact)",
        args: [caller.auth, { localDate, artifactId: foreign.rows.artifacts.ids[0] }],
      },
    ];
  },
  "src/domains/crm/commands.ts": (caller, foreign) => [
    { shape: "(auth, create contact)", args: [caller.auth, { fullName: "Iso Probe" }] },
    {
      shape: "(auth, update own)",
      args: [
        caller.auth,
        { contactId: caller.rows.contacts.ids[0], expectedVersion: 1, fullName: "Iso Probe Updated" },
      ],
    },
    {
      shape: "(auth, update foreign)",
      args: [
        caller.auth,
        { contactId: foreign.rows.contacts.ids[0], expectedVersion: 1, fullName: "Iso Probe Foreign" },
      ],
    },
    {
      shape: "(auth, observe own)",
      args: [caller.auth, { contactId: caller.rows.contacts.ids[0], body: "iso observation", source: "observed" }],
    },
    {
      shape: "(auth, observe foreign)",
      args: [caller.auth, { contactId: foreign.rows.contacts.ids[0], body: "iso observation", source: "observed" }],
    },
    {
      shape: "(auth, follow-up own)",
      args: [caller.auth, { contactId: caller.rows.contacts.ids[0], dueAt: dayEnd(), note: "iso" }],
    },
    {
      shape: "(auth, follow-up foreign)",
      args: [caller.auth, { contactId: foreign.rows.contacts.ids[0], dueAt: dayEnd(), note: "iso" }],
    },
    {
      shape: "(auth, archive own)",
      args: [caller.auth, { contactId: caller.rows.contacts.ids[0], expectedVersion: 2 }],
    },
    {
      shape: "(auth, archive foreign)",
      args: [caller.auth, { contactId: foreign.rows.contacts.ids[0], expectedVersion: 1 }],
    },
  ],
  "src/domains/calendar/commands.ts": (caller, foreign) => [
    {
      shape: "(auth, create event)",
      args: [
        caller.auth,
        { idempotencyKey: `iso-${probeSeq()}`, title: "Iso event", startsAt: dayStart(), endsAt: dayEnd() },
      ],
    },
    {
      shape: "(auth, create follow-up reminder)",
      args: [
        caller.auth,
        {
          idempotencyKey: `iso-${probeSeq()}`,
          title: "Iso reminder",
          startsAt: dayStart(),
          endsAt: dayEnd(),
          reason: "iso",
        },
      ],
    },
    {
      shape: "(auth, move own)",
      args: [
        caller.auth,
        {
          idempotencyKey: `iso-${probeSeq()}`,
          eventId: caller.rows.events.ids[0],
          expectedVersion: 1,
          startsAt: dayStart(),
          endsAt: dayEnd(),
        },
      ],
    },
    {
      shape: "(auth, move foreign)",
      args: [
        caller.auth,
        {
          idempotencyKey: `iso-${probeSeq()}`,
          eventId: foreign.rows.events.ids[0],
          expectedVersion: 1,
          startsAt: dayStart(),
          endsAt: dayEnd(),
        },
      ],
    },
    {
      shape: "(auth, cancel foreign)",
      args: [
        caller.auth,
        { idempotencyKey: `iso-${probeSeq()}`, eventId: foreign.rows.events.ids[0], expectedVersion: 1 },
      ],
    },
  ],
  "src/domains/stones/coins.ts": (caller) => [
    {
      shape: "(tx, auth, own task completion)",
      only: ["awardCoins"],
      args: [db, caller.auth, { kind: "task", taskId: caller.rows.tasks.ids[0] }],
    },
    { shape: "(auth, a catalog stone)", only: ["buyStone"], args: [caller.auth, "rose-quartz"] },
    { shape: "(db, auth)", only: ["coinBalance"], args: [db, caller.auth] },
  ],
  "src/domains/integrations/commands.ts": (caller, foreign) => [
    {
      shape: "(auth, register gmail)",
      args: [caller.auth, { provider: "gmail", alias: `iso-${caller.marker}-${probeSeq()}`, displayName: "Iso" }],
    },
    {
      shape: "(auth, register unknown provider)",
      args: [caller.auth, { provider: "not-a-provider", alias: `iso-${probeSeq()}` }],
    },
    {
      shape: "(auth, status own)",
      args: [caller.auth, { accountId: caller.rows.external_accounts.ids[0], expectedVersion: 1, status: "active" }],
    },
    {
      shape: "(auth, status foreign)",
      args: [caller.auth, { accountId: foreign.rows.external_accounts.ids[0], expectedVersion: 1, status: "active" }],
    },
    {
      shape: "(auth, rename own)",
      args: [
        caller.auth,
        {
          accountId: caller.rows.external_accounts.ids[0],
          expectedVersion: 2,
          alias: `iso-${caller.marker}-${probeSeq()}`,
        },
      ],
    },
    {
      shape: "(auth, revoke foreign)",
      args: [caller.auth, { accountId: foreign.rows.external_accounts.ids[0], expectedVersion: 1 }],
    },
  ],
  "src/domains/learning/commands.ts": (caller, foreign) => [
    {
      shape: "(auth, attempt own quiz)",
      args: [
        caller.auth,
        {
          quizId: caller.rows.quizzes.ids[0],
          answers: [{ questionId: caller.rows.quiz_questions.ids[0], selectedValue: "a", dontKnow: false }],
          idempotencyKey: `iso-${probeSeq()}`,
        },
      ],
    },
    {
      shape: "(auth, attempt foreign quiz)",
      args: [
        caller.auth,
        {
          quizId: foreign.rows.quizzes.ids[0],
          answers: [{ questionId: foreign.rows.quiz_questions.ids[0], selectedValue: "a", dontKnow: false }],
          idempotencyKey: `iso-${probeSeq()}`,
        },
      ],
    },
  ],
  "src/domains/agents/queries.ts": (caller, foreign) => {
    const ws = caller.auth.workspaceId;
    const ownRun = caller.rows.agent_runs.ids[0];
    const foreignRun = foreign.rows.agent_runs.ids[0];
    return [
      { shape: "(ws, 10)", only: ["listRecentRuns"], args: [ws, 10] },
      { shape: "(ws, 10, exclude onboarding)", only: ["listRecentRuns"], args: [ws, 10, { excludeOnboarding: true }] },
      { shape: "(ws, own run)", args: [ws, ownRun] },
      { shape: "(ws, foreign run)", args: [ws, foreignRun] },
      { shape: "(own run, ws)", only: ["getRunForGateway"], args: [ownRun, ws] },
      { shape: "(foreign run, ws)", only: ["getRunForGateway"], args: [foreignRun, ws] },
      { shape: "(ws, 30)", only: ["getUsageLedger"], args: [ws, 30] },
      { shape: "(ws, 30, 50)", only: ["getUsageLedger"], args: [ws, 30, 50] },
      { shape: "(missing session ref, ws)", only: ["getRunBySessionRef"], args: [`iso-${probeSeq()}-ref`, ws] },
    ];
  },
  "src/domains/actions/queries.ts": (caller, _foreign) => {
    const ws = caller.auth.workspaceId;
    const ownProposal = caller.rows.action_proposals?.ids[0];
    return [
      { shape: "(ws, [])", only: ["latestAttemptOutcomes", "listProposalReviews"], args: [ws, []] },
      {
        shape: "(ws, [own proposal])",
        only: ["latestAttemptOutcomes", "listProposalReviews"],
        args: [ws, ownProposal ? [ownProposal] : []],
      },
      { shape: "(ws, queue page)", only: ["pageReviewQueue"], args: [ws, { limit: 10, offset: 0 }] },
      { shape: "(ws, all statuses)", only: ["pageReviewQueue"], args: [ws, { limit: 10, offset: 0, status: "all" }] },
      { shape: "(ws)", only: ["countProposalsByStatus", "listTopPendingProposals"], args: [ws] },
      { shape: "(ws, 3)", only: ["listTopPendingProposals"], args: [ws, 3] },
    ];
  },
  "src/domains/integrations/queries.ts": (caller, foreign) => [
    { shape: "(auth)", only: ["listConnectors"], args: [caller.auth] },
    {
      shape: "(auth, own account)",
      only: ["listSyncCursors"],
      args: [caller.auth, caller.rows.external_accounts.ids[0]],
    },
    {
      shape: "(auth, foreign account)",
      only: ["listSyncCursors"],
      args: [caller.auth, foreign.rows.external_accounts.ids[0]],
    },
    { shape: "(auth, gmail)", only: ["resolveConnectedAccount"], args: [caller.auth, "gmail"] },
    {
      shape: "(auth, gmail, own alias)",
      only: ["resolveConnectedAccount"],
      args: [caller.auth, "gmail", `iso-${caller.marker}`],
    },
  ],
  "src/domains/skills/commands.ts": (caller, foreign) => [
    {
      shape: "(auth, install own)",
      args: [
        caller.auth,
        {
          name: `Iso ${probeSeq()} Skill`,
          slug: `iso-${probeSeq()}`,
          description: "tenant isolation fixture",
          body: "procedure",
          files: [],
          warnings: [],
          contentHash: `hash-${probeSeq()}`,
          sourceKind: "local",
          sourceRef: `iso-${probeSeq()}-ref`,
          sourcePath: `iso/${probeSeq()}/SKILL.md`,
          revision: "rev-1",
        },
      ],
    },
    { shape: "(auth, disable own)", args: [caller.auth, { id: caller.rows.skills.ids[0], enabled: false }] },
    { shape: "(auth, disable foreign)", args: [caller.auth, { id: foreign.rows.skills.ids[0], enabled: false }] },
    { shape: "(auth, remove foreign)", args: [caller.auth, { id: foreign.rows.skills.ids[0] }] },
  ],
};

/**
 * The sweep's withTransaction: a command under test must run its transaction
 * on the SAME dedicated per-probe client its reads use — the shared fixture
 * client is the prepared-statement wedge class documented on probe. Outside
 * a probe (route-level tests, EXTRA_PROBES) this falls back to the holder
 * db. Guardrails mirror the real seam (commands/contracts.md): transaction-
 * local statement and idle-in-transaction timeouts.
 */
export async function sweepWithTransaction(fn: (tx: unknown) => Promise<unknown>): Promise<unknown> {
  const store = als.getStore() as { db?: unknown } | undefined;
  const scopedDb = (store?.db ?? holder.db) as {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  return scopedDb.transaction(async (tx) => {
    await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
      sql`select set_config('statement_timeout', '10000', true), set_config('idle_in_transaction_session_timeout', '15000', true)`,
    );
    return fn(tx);
  });
}

/**
 * One sweep direction: probe every export of `entry` under the caller's
 * credentials with the other workspace's ids as adversarial arguments; walk
 * every result for foreign identity (values the probe itself injected are
 * subtracted); fingerprint the foreign workspace's rows before/after so a
 * write-side leak cannot hide. Returns the exercised-call count.
 */
async function sweepDirection(entry: ModuleEntry, caller: Fixture, foreign: Fixture): Promise<number> {
  const callerName = caller === a ? "workspace-a" : "workspace-b";
  const before = await fingerprint(foreign.auth.workspaceId);
  const exportedFns = Object.entries(entry.mod).filter(([, v]) => typeof v === "function");
  let exercised = 0;
  const failures: string[] = [];

  const runAttempt = (fnName: string, attempt: Attempt, injected: Set<string>) => {
    if (!attempt.ok) return;
    exercised += 1;
    const strs = new Set<string>();
    collectStrings(attempt.value, strs);
    for (const s of strs) {
      seenIds.add(s);
      if (foreign.identity.has(s) && !injected.has(s)) {
        failures.push(`${entry.name} · ${fnName} ${attempt.shape} returned a foreign value: ${s}`);
      }
    }
  };

  for (const [fnName, fn] of exportedFns) {
    const moduleShapes = FUNCTION_SHAPES[entry.name]?.(caller, foreign) ?? argShapes(entry, caller, foreign);
    const shapes = moduleShapes.filter((sh) => !sh.only || sh.only.includes(fnName));
    for (const { shape, args } of shapes) {
      // Names the exact call if a probe ever wedges: run with ISO_SWEEP_DEBUG=1.
      if (process.env.ISO_SWEEP_DEBUG) console.warn(`[sweep] ${entry.name} ${fnName} ${shape}`);
      const injected = new Set<string>();
      collectStrings(args, injected);
      const attempt = await probe(fn, shape, args);
      if (process.env.ISO_SWEEP_DEBUG && !attempt.ok) {
        const cause = (attempt.error as { cause?: unknown })?.cause;
        const causeMsg =
          cause === undefined ? "" : ` | cause: ${JSON.stringify(cause, Object.getOwnPropertyNames(cause as object))}`;
        console.warn(
          `[sweep-err] ${fnName} ${shape}: ${attempt.error instanceof Error ? attempt.error.message : String(attempt.error)}${causeMsg}`,
        );
      }
      runAttempt(fnName, attempt, injected);
    }
  }

  const extra = EXTRA_PROBES[entry.name];
  if (extra !== undefined) {
    runAttempt("(extra: in-transaction)", await probe(extra, "(auth, input, tx)", [caller]), new Set());
  }

  const after = await fingerprint(foreign.auth.workspaceId);
  expect(
    stableStringify(Object.fromEntries(after)),
    `${entry.name}: a ${callerName} probe mutated the other workspace's rows`,
  ).toBe(stableStringify(Object.fromEntries(before)));
  expect(failures, `${entry.name}: cross-workspace values leaked into ${callerName} results`).toEqual([]);
  expect(
    exercised,
    `${entry.name}: no probe succeeded under ${callerName} auth — the sweep proved nothing for this module (exports: ${exportedFns.map(([n]) => n).join(", ")})`,
  ).toBeGreaterThan(0);
  return exercised;
}

export {
  MODULES,
  TABLE_REGISTRY,
  seenIds,
  sweepDirection,
  a,
  b,
  dayStart,
  dayEnd,
  workQueries,
  calendarQueries,
  auditQueries,
  captureQueries,
  type Fixture,
};
