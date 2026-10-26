import type postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { DEFAULT_MODEL_ID } from "./models";
import { agentProfiles } from "./schema";

/*
 * The first-party profile, ensured before a start so the engine's lookup
 * succeeds. One owner in v1 ships one profile (agents/product.md): idempotent
 * on (workspace, name) via the unique index, so two racing starts land on one
 * row.
 *
 * ponytail: model id and budget defaults live here, not in a settings screen,
 * until profile management lands.
 */
/** The first-party profile's capabilities. documents.search and the wiki tools are reads or internal writes. */
export const DEFAULT_ALLOWED_TOOLS = [
  "tasks.read",
  "documents.search",
  "wiki.read",
  "wiki.ingest",
  "wiki.lint",
  "gmail.send",
  // ASH-283: a Notion write is a proposal, and the proposal is refused before
  // it is created unless the run was granted the capability.
  "notion.page.append",
  "notion.page.create",
  // ASH-279: reads a meeting transcript and proposes tasks from it. The
  // proposals themselves still need tasks.create, which is separate.
  "meetings.debrief",
  // ASH-285: drafts a Linear-issue proposal note from pasted material. An
  // internal write at prepare risk - it never calls Linear - and without a
  // row here the tool is a dead 403 on every call.
  "linear.issue.propose",
  // ASH-282: proposes conflict-resolution moves the owner approves first;
  // without a row here the tool is a dead 403 on every call.
  "calendar.propose",
  // ASH-306: listing records is navigation, the same authority as reading them.
  "records.browse",
  // Connected reads. A capability in the risk table but absent here can never
  // be granted: the policy snapshot copies this list verbatim, so the tool is
  // advertised to the model and denied on every call.
  "gmail.read",
  // Same authority as searching mail; without a row the thread tool is a
  // dead 403 on every call.
  "gmail.thread.read",
  // GitHub and Slack reads, advertised through the same gateway.
  "github.read",
  "github.issue.read",
  "slack.channels.read",
  "slack.read",
  "linear.read",
  "linear.issue.read",
  "calendar.read",
  // Generic registry reads (clusters A-D). Same authority as the gateway
  // reads above; without rows here the tools are dead 403s on every call.
  "googlecalendar.events.read",
  "googledrive.files.read",
  "googledocs.documents.read",
  "googlesheets.spreadsheets.read",
  "discord.guilds.read",
  "zoom.meetings.read",
  "calendly.events.read",
  "asana.tasks.read",
  "trello.cards.read",
  "airtable.bases.read",
  "canva.designs.read",
  "hubspot.contacts.read",
  "stripe.payments.read",
  "notion.read",
  "notion.page.read",
  "linkedin.profile.read",
  "instagram.profile.read",
  "instagram.media.read",
  // NotebookLM parity. Opening a notebook reads its sources and artifacts.
  "notebook.open",
  // Run follow-ups become reviewable task proposals, never silent task
  // writes: the tool creates a prepare-risk proposal and the owner's approval
  // creates the task. Same class as wiki.ingest, which also writes locally.
  "tasks.create",
  // Public-web reads. Query terms and fetched URLs leave the workspace (the
  // registry's egress note), nothing is written, and the zero-key provider
  // means no spend. web.fetch answers a clear config error until a Firecrawl
  // URL is set; granting it keeps the refusal honest instead of a dead 403.
  "web.search",
  "web.fetch",
  // AI changes to a saved artifact arrive as reviewable revision proposals,
  // never silent edits. Same prepare-risk class as tasks.create.
  "artifacts.revise",
  // Composio Instant tools (spec #316): derived capability names from the
  // generated catalog, granted to default profiles for the same reason as the
  // generic reads above. Regenerate with: pnpm exec tsx scripts/sync-instant-catalog.ts
  // (execute-time gates: policy snapshot, no_auth re-check, deny-by-default
  // read-only classification, withQuota — see instant-tools.ts).
    "instant.composio.composio_ask_oracle", "instant.composio.composio_check_active_connection", "instant.composio.composio_check_active_connections",
    "instant.composio.composio_create_plan", "instant.composio.composio_enable_trigger", "instant.composio.composio_execute_agent",
    "instant.composio.composio_execute_tool", "instant.composio.composio_get_dependency_graph", "instant.composio.composio_get_required_parameters",
    "instant.composio.composio_get_response_schema", "instant.composio.composio_initiate_connection", "instant.composio.composio_list_toolkits",
    "instant.composio.composio_list_triggers", "instant.composio.composio_manage_connection", "instant.composio.composio_manage_connections",
    "instant.composio.composio_multi_execute_tool", "instant.composio.composio_remote_bash_tool", "instant.composio.composio_remote_workbench",
    "instant.composio.composio_retrieve_toolkits", "instant.composio.composio_search_agent", "instant.composio.composio_search_tools",
    "instant.composio.composio_wait_for_connection", "instant.composio.composio_wait_for_connections", "instant.composio.composio_get_tool_schemas",
    "instant.composio_search.composio_search_duck_duck_go_search", "instant.composio_search.composio_search_event_search", "instant.composio_search.composio_search_exa_answer",
    "instant.composio_search.composio_search_exa_similarlink", "instant.composio_search.composio_search_finance_search", "instant.composio_search.composio_search_google_maps_search",
    "instant.composio_search.composio_search_image_search", "instant.composio_search.composio_search_news_search", "instant.composio_search.composio_search_scholar_search",
    "instant.composio_search.composio_search_search", "instant.composio_search.composio_search_shopping_search", "instant.composio_search.composio_search_tavily_search",
    "instant.composio_search.composio_search_trends_search", "instant.hackernews.hackernews_get_frontpage", "instant.hackernews.hackernews_get_item_with_id",
    "instant.hackernews.hackernews_get_latest_posts", "instant.hackernews.hackernews_get_todays_posts", "instant.hackernews.hackernews_get_user",
    "instant.hackernews.hackernews_search_posts", "instant.weathermap.weathermap_weather", "instant.text_to_pdf.text_to_pdf_convert_text_to_pdf",
    "instant.browser_tool.browser_tool_copy_selected_text", "instant.browser_tool.browser_tool_drag_and_drop", "instant.browser_tool.browser_tool_fetch_webpage",
    "instant.browser_tool.browser_tool_get_clipboard", "instant.browser_tool.browser_tool_keyboard_shortcut", "instant.browser_tool.browser_tool_mouse_click",
    "instant.browser_tool.browser_tool_mouse_double_click", "instant.browser_tool.browser_tool_mouse_down", "instant.browser_tool.browser_tool_mouse_move",
    "instant.browser_tool.browser_tool_mouse_up", "instant.browser_tool.browser_tool_navigate", "instant.browser_tool.browser_tool_paste_text",
    "instant.browser_tool.browser_tool_perform_web_task", "instant.browser_tool.browser_tool_screenshot_webpage", "instant.browser_tool.browser_tool_scroll",
    "instant.browser_tool.browser_tool_set_clipboard", "instant.browser_tool.browser_tool_take_screenshot", "instant.browser_tool.browser_tool_type_text",
    "instant.entelligence.entelligence_add_a_new_repository", "instant.entelligence.entelligence_interact_with_the_repository_agent", "instant.bench.bench_sleep",
    "instant.cve_now_mcp.cve_now_mcp_check_stack", "instant.cve_now_mcp.cve_now_mcp_get_vulnerability", "instant.cve_now_mcp.cve_now_mcp_list_feed",
    "instant.gleif.gleif_export_lei_records", "instant.gleif.gleif_get_autocompletions", "instant.gleif.gleif_get_fund_or_branch_relationship",
    "instant.gleif.gleif_get_fuzzy_completions", "instant.gleif.gleif_get_lei_issuer_for_record", "instant.gleif.gleif_get_lei_record",
    "instant.gleif.gleif_get_parent_information", "instant.gleif.gleif_get_reference_item", "instant.gleif.gleif_get_related_lei_record",
    "instant.gleif.gleif_get_successor_entity", "instant.gleif.gleif_list_child_entities", "instant.gleif.gleif_list_child_relationships",
    "instant.gleif.gleif_list_fund_or_branch_entities", "instant.gleif.gleif_list_fund_or_branch_relationships", "instant.gleif.gleif_list_lei_field_modifications",
    "instant.gleif.gleif_list_lei_isins", "instant.gleif.gleif_list_lei_issuer_jurisdictions", "instant.gleif.gleif_list_reference_data",
    "instant.gleif.gleif_list_registration_agents", "instant.gleif.gleif_list_successor_entities", "instant.gleif.gleif_search_lei_records",
];

export async function ensureProfile(workspaceId: string, name = "alfred") {
  const [existing] = await db
    .select({ id: agentProfiles.id, allowedTools: agentProfiles.allowedTools })
    .from(agentProfiles)
    .where(eq(agentProfiles.workspaceId, workspaceId))
    .limit(1);
  if (existing) {
    // A profile made before documents.search existed gains that read-only
    // capability. Nothing else is added, and runs already started keep their
    // frozen snapshot.
    const tools = Array.isArray(existing.allowedTools) ? (existing.allowedTools as string[]) : [];
    // Reads and internal wiki writes gained after early profiles were made.
    // Nothing else is added, and runs already started keep their frozen snapshot.
    // Connected reads are here for the same reason as the wiki ones: an
    // existing profile's frozen list would otherwise never gain them, and the
    // tool would fail closed forever with "not in this run's policy snapshot".
    // `gmail.thread.read` is in this list for the same reason: it ships as a
    // gateway tool, so a profile without it makes the tool a dead 403.
    const gained = [
      "documents.search",
      "notion.page.append",
      "notion.page.create",
      "meetings.debrief",
      // ASH-285: an existing profile without this fails closed on every
      // linear_issue_propose call; the draft is an internal write.
      "linear.issue.propose",
      // ASH-282: an existing profile without this fails closed on every
      // calendar_conflict_propose call; the draft is an internal write.
      "calendar.propose",
      "records.browse",
      "wiki.read",
      "wiki.ingest",
      "wiki.lint",
      "gmail.read",
      "gmail.thread.read",
      "github.read",
      "github.issue.read",
      "slack.channels.read",
      "slack.read",
      "linear.read",
      "linear.issue.read",
      "calendar.read",
      // Generic registry reads (clusters A-D), granted for the same reason as
      // the connected reads above: an existing profile's frozen list would
      // otherwise never gain them, and the tool would fail closed forever.
      "googlecalendar.events.read",
      "googledrive.files.read",
      "googledocs.documents.read",
      "googlesheets.spreadsheets.read",
      "discord.guilds.read",
      "zoom.meetings.read",
      "calendly.events.read",
      "asana.tasks.read",
      "trello.cards.read",
      "airtable.bases.read",
      "canva.designs.read",
      "hubspot.contacts.read",
      "stripe.payments.read",
      "notion.read",
  "notion.page.read",
  "linkedin.profile.read",
  "instagram.profile.read",
  "instagram.media.read",
      "notebook.open",
      // Prepare-risk proposal writes gained with the tasks_propose tool;
      // without this, existing profiles would fail closed on every call.
      "tasks.create",
      // Public-web reads granted with the default profile; an existing
      // profile without them makes the tools a dead 403 on every call.
      "web.search",
      "web.fetch",
      "artifacts.revise",
      // Composio Instant tools (spec #316): derived capability names from the
      // generated catalog. Granted for the same reason as the generic reads
      // above — an existing profile without them dead-403s on every call. The
      // list is regenerated with: pnpm exec tsx scripts/sync-instant-catalog.ts
      // (execute-time gates: policy snapshot, no_auth re-check, deny-by-default
      // read-only classification, withQuota — see instant-tools.ts).
    "instant.composio.composio_ask_oracle", "instant.composio.composio_check_active_connection", "instant.composio.composio_check_active_connections",
    "instant.composio.composio_create_plan", "instant.composio.composio_enable_trigger", "instant.composio.composio_execute_agent",
    "instant.composio.composio_execute_tool", "instant.composio.composio_get_dependency_graph", "instant.composio.composio_get_required_parameters",
    "instant.composio.composio_get_response_schema", "instant.composio.composio_initiate_connection", "instant.composio.composio_list_toolkits",
    "instant.composio.composio_list_triggers", "instant.composio.composio_manage_connection", "instant.composio.composio_manage_connections",
    "instant.composio.composio_multi_execute_tool", "instant.composio.composio_remote_bash_tool", "instant.composio.composio_remote_workbench",
    "instant.composio.composio_retrieve_toolkits", "instant.composio.composio_search_agent", "instant.composio.composio_search_tools",
    "instant.composio.composio_wait_for_connection", "instant.composio.composio_wait_for_connections", "instant.composio.composio_get_tool_schemas",
    "instant.composio_search.composio_search_duck_duck_go_search", "instant.composio_search.composio_search_event_search", "instant.composio_search.composio_search_exa_answer",
    "instant.composio_search.composio_search_exa_similarlink", "instant.composio_search.composio_search_finance_search", "instant.composio_search.composio_search_google_maps_search",
    "instant.composio_search.composio_search_image_search", "instant.composio_search.composio_search_news_search", "instant.composio_search.composio_search_scholar_search",
    "instant.composio_search.composio_search_search", "instant.composio_search.composio_search_shopping_search", "instant.composio_search.composio_search_tavily_search",
    "instant.composio_search.composio_search_trends_search", "instant.hackernews.hackernews_get_frontpage", "instant.hackernews.hackernews_get_item_with_id",
    "instant.hackernews.hackernews_get_latest_posts", "instant.hackernews.hackernews_get_todays_posts", "instant.hackernews.hackernews_get_user",
    "instant.hackernews.hackernews_search_posts", "instant.weathermap.weathermap_weather", "instant.text_to_pdf.text_to_pdf_convert_text_to_pdf",
    "instant.browser_tool.browser_tool_copy_selected_text", "instant.browser_tool.browser_tool_drag_and_drop", "instant.browser_tool.browser_tool_fetch_webpage",
    "instant.browser_tool.browser_tool_get_clipboard", "instant.browser_tool.browser_tool_keyboard_shortcut", "instant.browser_tool.browser_tool_mouse_click",
    "instant.browser_tool.browser_tool_mouse_double_click", "instant.browser_tool.browser_tool_mouse_down", "instant.browser_tool.browser_tool_mouse_move",
    "instant.browser_tool.browser_tool_mouse_up", "instant.browser_tool.browser_tool_navigate", "instant.browser_tool.browser_tool_paste_text",
    "instant.browser_tool.browser_tool_perform_web_task", "instant.browser_tool.browser_tool_screenshot_webpage", "instant.browser_tool.browser_tool_scroll",
    "instant.browser_tool.browser_tool_set_clipboard", "instant.browser_tool.browser_tool_take_screenshot", "instant.browser_tool.browser_tool_type_text",
    "instant.entelligence.entelligence_add_a_new_repository", "instant.entelligence.entelligence_interact_with_the_repository_agent", "instant.bench.bench_sleep",
    "instant.cve_now_mcp.cve_now_mcp_check_stack", "instant.cve_now_mcp.cve_now_mcp_get_vulnerability", "instant.cve_now_mcp.cve_now_mcp_list_feed",
    "instant.gleif.gleif_export_lei_records", "instant.gleif.gleif_get_autocompletions", "instant.gleif.gleif_get_fund_or_branch_relationship",
    "instant.gleif.gleif_get_fuzzy_completions", "instant.gleif.gleif_get_lei_issuer_for_record", "instant.gleif.gleif_get_lei_record",
    "instant.gleif.gleif_get_parent_information", "instant.gleif.gleif_get_reference_item", "instant.gleif.gleif_get_related_lei_record",
    "instant.gleif.gleif_get_successor_entity", "instant.gleif.gleif_list_child_entities", "instant.gleif.gleif_list_child_relationships",
    "instant.gleif.gleif_list_fund_or_branch_entities", "instant.gleif.gleif_list_fund_or_branch_relationships", "instant.gleif.gleif_list_lei_field_modifications",
    "instant.gleif.gleif_list_lei_isins", "instant.gleif.gleif_list_lei_issuer_jurisdictions", "instant.gleif.gleif_list_reference_data",
    "instant.gleif.gleif_list_registration_agents", "instant.gleif.gleif_list_successor_entities", "instant.gleif.gleif_search_lei_records",
    ];
    const missing = gained.filter((t) => !tools.includes(t));
    if (missing.length) {
      await db.update(agentProfiles).set({ allowedTools: [...tools, ...missing] }).where(eq(agentProfiles.id, existing.id));
    }
    return existing.id;
  }
  const [profile] = await db
    .insert(agentProfiles)
    .values({
      workspaceId,
      name,
      // Placeholder, not a persona: the workspace's supervisor is the user's
      // own representation (agents/product.md, revised 2026-10-21). Onboarding
      // or the operator replaces this description with the personified brief;
      // shipping a fixed "Chief of staff" persona would silently contradict
      // what the run's instructions say it is.
      description: "Your agent. Name it and shape it in Settings to make it yours.",
      // The catalog's default, not a stale provider id: the run frozen from
      // this row is what spend is priced against, so it has to name a model
      // that exists.
      modelPolicy: { primary: DEFAULT_MODEL_ID },
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      budgetPolicy: { perRunCeilingUsd: "2.00", dailyCeilingUsd: "10.00" },
      isDefault: true,
    })
    .onConflictDoNothing()
    .returning({ id: agentProfiles.id });
  if (profile) return profile.id;
  const [raced] = await db
    .select({ id: agentProfiles.id })
    .from(agentProfiles)
    .where(eq(agentProfiles.workspaceId, workspaceId))
    .limit(1);
  if (!raced) throw new Error("agent profile did not persist");
  return raced.id;
}

/*
 * The orphaned-run remedy. A run whose worker died — a Vercel function evicted,
 * a crash between the queued row and the session — stays `queued`/`running`
 * forever, holding a spending reservation against the daily ceiling that no
 * caller will ever settle. This sweep is what closes it.
 *
 * Deliberately not a domain command: it takes the raw postgres-js client
 * because a cron sweep runs outside any request, has no AuthContext, and spans
 * every workspace. It cannot use closeRun, which is scoped to one workspace and
 * one auth. `for update skip locked` is the concurrency guard, so two
 * overlapping sweeps cannot both claim the same run.
 *
 * The two active states and the error text are constants, so they are inlined:
 * the sweep is the only writer, and a bound array makes postgres-js guess
 * parameter types (it mis-inferred a sibling Date as text, a `bytes.js` throw).
 * Ids stay bound — an `in` list of uuids is exactly what a parameter is for.
 */

/** The live states the run table's partial active index covers. */
const ACTIVE_IN = "'queued', 'running'";
const TIMED_OUT = "run timed out and was reconciled";

/**
 * Marks every queued/running run created before `olderThanMs` ago as failed,
 * releases its open spending reservation, and leaves one `run.reconciled`
 * event. Returns the ids it closed, for the caller's log or metric.
 */
export async function reconcileStaleRuns(
  rawClient: ReturnType<typeof postgres>,
  olderThanMs: number = 24 * 3600 * 1000,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const now = new Date().toISOString();

  return rawClient.begin(async (tx) => {
    const stale = await tx<{ id: string }[]>`
      select id from agent_runs
      where state::text in (${tx.unsafe(ACTIVE_IN)})
        and created_at < ${cutoff}::timestamptz
      for update skip locked
    `;
    if (stale.length === 0) return [];

    const ids = stale.map((row) => row.id);

    await tx`
      update agent_runs
      set state = 'failed',
          error = ${TIMED_OUT},
          ended_at = ${now}::timestamptz,
          updated_at = ${now}::timestamptz,
          version = version + 1
      where id = any(${ids})
    `;

    // Release, not settle: the run did no work, so its budget goes back. Guarded
    // on status = 'reserved' so a settled or already-released claim is untouched.
    await tx`
      update spending_reservations
      set status = 'released',
          updated_at = ${now}::timestamptz,
          version = version + 1
      where run_id = any(${ids}) and status = 'reserved'
    `;

    // One event per run, sequence claimed with max+1 — the shape appendEvent
    // uses, so a live SSE reader sees the close.
    await tx`
      insert into run_events (workspace_id, run_id, sequence, type, data, created_at)
      select r.workspace_id, r.id,
             coalesce((select max(e.sequence) from run_events e where e.run_id = r.id), 0) + 1,
             'run.reconciled',
             ${JSON.stringify({ error: TIMED_OUT })}::jsonb,
             ${now}::timestamptz
      from agent_runs r
      where r.id = any(${ids})
    `;

    await tx`
      update agent_runs
      set last_event_seq = greatest(last_event_seq,
            (select max(sequence) from run_events e where e.run_id = agent_runs.id))
      where id = any(${ids})
    `;

    return ids;
  });
}

/*
 * Profile management (spec "It learns your taste": tone, explanation depth
 * and writing preferences can be reviewed and changed; the person can
 * inspect, correct or retire what is remembered). The learned brief is
 * description + instructions; this is its one review-and-change write. Empty
 * retires that part (null, not a blank string); the onboarding session row
 * keeps the verbatim original as provenance, and nothing on the run path
 * reads it back - retiring is real.
 *
 * The profile's `name` is NOT editable here: engine.start resolves profiles
 * by name and every caller passes the machine key ("alfred"), so renaming
 * would break every future run start. A persona display name needs its own
 * column and display surfaces - recorded as a gap in ASH-220.
 *
 * Compare-and-set on the row version, like preferences: two open settings
 * tabs cannot silently overwrite each other.
 */
export type ProfileBriefResult =
  | { ok: true; profile: { name: string; description: string | null; instructions: string | null; version: number } }
  | { ok: false; kind: "validation"; error: string }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "not_found" };

const BRIEF_LIMITS = { description: 500, instructions: 4000 } as const;

export async function updateDefaultProfileBrief(
  auth: AuthContext,
  input: { description?: string; instructions?: string; expectedVersion: number },
): Promise<ProfileBriefResult> {
  const description = (input.description ?? "").trim();
  if (description.length > BRIEF_LIMITS.description) return { ok: false, kind: "validation", error: `Keep the description under ${BRIEF_LIMITS.description} characters.` };
  const instructions = (input.instructions ?? "").trim();
  if (instructions.length > BRIEF_LIMITS.instructions) return { ok: false, kind: "validation", error: `Keep the brief under ${BRIEF_LIMITS.instructions} characters.` };

  return withTransaction(async (tx) => {
    const [current] = await tx
      .select({ id: agentProfiles.id, version: agentProfiles.version })
      .from(agentProfiles)
      .where(and(eq(agentProfiles.workspaceId, auth.workspaceId), eq(agentProfiles.isDefault, true)))
      .limit(1);
    if (!current) return { ok: false, kind: "not_found" } as const;

    const patch = { description: description || null, instructions: instructions || null };
    const [updated] = await tx
      .update(agentProfiles)
      .set({ ...patch, version: current.version + 1, updatedAt: new Date(), updatedBy: auth.userId })
      .where(and(eq(agentProfiles.id, current.id), eq(agentProfiles.version, input.expectedVersion)))
      .returning();
    // No row: the version moved under us - the caller's view is stale.
    if (!updated) return { ok: false, kind: "conflict" } as const;

    await recordAudit(auth, {
      action: "agent_profile.brief_saved",
      subjectType: "agent_profile",
      subjectId: updated.id,
      summary: `Assistant brief saved: ${updated.description ? "description set" : "description retired"}, ${updated.instructions ? "brief set" : "brief retired"}`,
    }, tx);
    return { ok: true, profile: { name: updated.name, description: updated.description, instructions: updated.instructions, version: updated.version } } as const;
  });
}
