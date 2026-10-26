import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { documents, embeddings, files } from "@/domains/knowledge/schema";
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "@/integrations/embeddings/provider";
import type { ExtractionResult } from "@/integrations/extraction/provider";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
const extractor = vi.hoisted(() => ({ extract: vi.fn<() => Promise<ExtractionResult>>() }));
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("@/integrations/extraction/docling-docker", () => ({ createDoclingDockerProvider: () => extractor }));
vi.mock("@/integrations/object-store/object-store", () => ({ readBlob: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }));

import { embedExtraction } from "@/domains/knowledge/embedding";
import { searchDocumentsForAgent } from "@/domains/knowledge/agent-search";
import { ensureProfile } from "@/domains/agents/commands";
import { agentProfiles, agentRuns, toolCalls } from "@/domains/agents/schema";
import { listDocumentSearchResults } from "@/domains/agents/queries";
import { actionProposals } from "@/domains/actions/schema";
import { extractDocument } from "@/domains/knowledge/extraction";

/** Deterministic embedder: words hash into buckets, so shared words mean closeness. */
function fakeProvider(model = "fake:hash-1536"): EmbeddingProvider & { calls: number } {
  const provider = {
    model,
    calls: 0,
    async embed(values: string[]) {
      provider.calls++;
      return values.map((value) => {
        const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        for (const word of value.toLowerCase().match(/[a-z]+/g) ?? []) {
          let h = 0;
          for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % EMBEDDING_DIMENSIONS;
          v[h] += 1;
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
  return provider;
}

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { vi.unstubAllEnvs(); await handle?.client.end(); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DOCLING_SERVE_URL", "http://docling.fixture");
  vi.stubEnv("OPENAI_API_KEY", "");
});


const LEASE = "The tenant pays monthly rent of twelve hundred dollars. The landlord keeps the security deposit. ".repeat(30);
const PAYROLL = "Payroll runs on the fifteenth. Overtime is paid at one and a half times the hourly wage. ".repeat(30);

async function seed(auth: { workspaceId: string; userId: string }, text: string, title: string, provider: EmbeddingProvider) {
  const db = holder.db!;
  const [blob] = await db.insert(blobObjects).values({
    workspaceId: auth.workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(),
    sizeBytes: 4, mimeType: "application/pdf",
  }).returning();
  const [file] = await db.insert(files).values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: `${title}.pdf` }).returning();
  const [doc] = await db.insert(documents).values({ workspaceId: auth.workspaceId, title, fileId: file.id, mimeType: "application/pdf" }).returning();
  extractor.extract.mockResolvedValueOnce({ ok: true, text, spans: [{ page: 1, start: 0, end: text.length }], pageCount: 1, extractor: "fixture@1" });
  const result = await extractDocument({ ...auth, role: "owner" as const }, { documentId: doc.id });
  if (!result.ok) throw new Error("seed failed");
  await embedExtraction({ ...auth, role: "owner" as const }, { extractionId: result.extractionId, provider });
  return doc;
}
/** Seed a document with extraction text and no embeddings: the no-key path. */
async function seedText(auth: { workspaceId: string; userId: string }, text: string, title: string) {
  const db = holder.db!;
  const [blob] = await db.insert(blobObjects).values({
    workspaceId: auth.workspaceId, storageKey: `private/${crypto.randomUUID()}`, contentHash: crypto.randomUUID(),
    sizeBytes: 4, mimeType: "application/pdf",
  }).returning();
  const [file] = await db.insert(files).values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: `${title}.pdf` }).returning();
  const [doc] = await db.insert(documents).values({ workspaceId: auth.workspaceId, title, fileId: file.id, mimeType: "application/pdf" }).returning();
  extractor.extract.mockResolvedValueOnce({ ok: true, text, spans: [{ page: 1, start: 0, end: text.length }], pageCount: 1, extractor: "fixture@1" });
  const result = await extractDocument({ ...auth, role: "owner" as const }, { documentId: doc.id });
  if (!result.ok) throw new Error("seed failed");
  return doc;
}
const workspace = async () => ({ ...await seedWorkspace(holder.db!, `ds-${crypto.randomUUID()}`), role: "owner" as const });

suite("documents.search for the agent (real Postgres + pgvector)", () => {
  it("returns document id, title, passage and span for the caller's workspace only", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    const b = await workspace();
    const lease = await seed(a, LEASE, "lease", provider);
    await seed(a, PAYROLL, "payroll", provider);
    await seed(b, LEASE, "other tenant lease", provider);
    const res = await searchDocumentsForAgent({ ...a, role: "viewer" }, { query: "monthly rent security deposit", limit: 3, provider });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.results[0]).toMatchObject({ documentId: lease.id, title: "lease", span: { page: 1 } });
    expect(LEASE.slice(res.results[0].span.start, res.results[0].span.end).startsWith(res.results[0].text.slice(0, 20))).toBe(true);
    expect(res.results.map((r) => r.title)).not.toContain("other tenant lease");
    const bRes = await searchDocumentsForAgent({ ...b, role: "viewer" }, { query: "rent", provider });
    expect(bRes.ok && bRes.results.every((r) => r.title === "other tenant lease")).toBe(true);
  });

  it("caps the limit and passage length, and rejects an empty query", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    await seed(a, LEASE, "lease", provider);
    const res = await searchDocumentsForAgent(a, { query: "rent", limit: 500, provider });
    expect(res.ok && res.results.length <= 10 && res.results.every((r) => r.text.length <= 1201)).toBe(true);
    expect(await searchDocumentsForAgent(a, { query: "   ", provider })).toEqual({ ok: false, error: "query is empty" });
  });

  it("writes nothing: no proposals, documents or chunks change", async () => {
    const provider = fakeProvider();
    const a = await workspace();
    await seed(a, LEASE, "lease", provider);
    const count = async () => [
      (await holder.db!.select().from(actionProposals)).length,
      (await holder.db!.select().from(documents).where(eq(documents.workspaceId, a.workspaceId))).length,
      (await holder.db!.select().from(embeddings).where(eq(embeddings.workspaceId, a.workspaceId))).length,
    ];
    const before = await count();
    await searchDocumentsForAgent(a, { query: "rent", provider });
    expect(await count()).toEqual(before);
  });

  it("gives fixed messages for provider failures, never provider text", async () => {
    const a = await workspace();
    // No embedding key no longer fails closed: the workspace simply has no
    // documents, so the full-text fallback answers with an empty, labelled
    // result instead of the old "not configured" error.
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(await searchDocumentsForAgent(a, { query: "rent" })).toEqual({ ok: true, query: "rent", mode: "text", results: [] });
    const broken: EmbeddingProvider = { model: "m", embed: async () => { throw new Error("401 sk-live-secret"); } };
    const res = await searchDocumentsForAgent(a, { query: "rent", provider: broken });
    expect(res).toEqual({ ok: false, error: "document search failed, try again" });
  });

  it("falls back to full-text search over current extractions when no embedding key is configured", async () => {
    const a = await workspace();
    const b = await workspace();
    // Seed text only: the fallback must need no embeddings and no provider.
    const lease = await seedText(a, LEASE, "lease");
    await seedText(a, PAYROLL, "payroll");
    await seedText(b, LEASE, "other tenant lease");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const res = await searchDocumentsForAgent({ ...a, role: "viewer" }, { query: "security deposit", limit: 3 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe("text");
    expect(res.results[0]).toMatchObject({ documentId: lease.id, title: "lease" });
    expect(res.results[0].text.toLowerCase()).toContain("security deposit");
    // The span is real offsets into the extraction text, the ChunkHit contract.
    const span = res.results[0].span;
    expect(LEASE.slice(span.start, span.end)).toBe(res.results[0].text);
    expect(res.results.map((r) => r.title)).not.toContain("other tenant lease");
    const bRes = await searchDocumentsForAgent({ ...b, role: "viewer" }, { query: "security deposit" });
    expect(bRes.ok && bRes.results.every((r) => r.title === "other tenant lease")).toBe(true);
  });

  it("the full-text fallback respects a dossier boundary and skips archived documents", async () => {
    const a = await workspace();
    const lease = await seedText(a, LEASE, "lease");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    // An empty boundary matches nothing, never everything.
    const empty = await searchDocumentsForAgent(a, { query: "rent", projectId: crypto.randomUUID() });
    expect(empty).toEqual({ ok: false, error: "project not found" });
    await holder.db!.update(documents).set({ archivedAt: new Date() }).where(eq(documents.id, lease.id));
    const res = await searchDocumentsForAgent(a, { query: "rent" });
    expect(res).toEqual({ ok: true, query: "rent", mode: "text", results: [] });
  });

  it("the default profile grants the read and internal tools, and an older profile gains only those", async () => {
    const a = await workspace();
    await ensureProfile(a.workspaceId);
    const [p] = await holder.db!.select().from(agentProfiles).where(eq(agentProfiles.workspaceId, a.workspaceId));
    // A closed list on purpose: a capability the profile does not grant is
    // denied on every call, so any addition here is a deliberate widening and
    // deserves this diff.
    expect(p.allowedTools).toEqual([
      "tasks.read",
      "documents.search",
      "wiki.read",
      "wiki.ingest",
      "wiki.lint",
      "gmail.send",
      // ASH-283 / ASH-279 / ASH-306: a Notion write and a meeting debrief are
      // only ever proposals, and listing records is navigation. All four are
      // denied on every call without a grant, so they widen this list.
      "notion.page.append",
      "notion.page.create",
      "meetings.debrief",
      // ASH-285: drafting a Linear issue persists a proposal note - an
      // internal write that still fails closed without the grant.
      "linear.issue.propose",
      // ASH-282: proposing a calendar move persists a review card - an
      // internal write that still fails closed without the grant.
      "calendar.propose",
      "records.browse",
      "gmail.read",
      "gmail.thread.read",
      "github.read",
      "github.issue.read",
      // ASH-284: triage drafting persists a review-queue proposal - an
      // internal write, denied on every call without the grant.
      "github.issue.triage",
      "slack.channels.read",
      "slack.read",
      "linear.read",
      "linear.issue.read",
      "calendar.read",
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
      "tasks.create",
      "web.search",
      "web.fetch",
      "artifacts.revise",
      // Composio Instant tools (spec #316): granted to default profiles; the
      // closed list stays deliberate — widening shows up in this diff.
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
    ]);
    const b = await workspace();
    await ensureProfile(b.workspaceId);
    await holder.db!.update(agentProfiles).set({ allowedTools: ["tasks.read"] }).where(eq(agentProfiles.workspaceId, b.workspaceId));
    await ensureProfile(b.workspaceId);
    await ensureProfile(b.workspaceId);
    const [old] = await holder.db!.select().from(agentProfiles).where(eq(agentProfiles.workspaceId, b.workspaceId));
    expect(old.allowedTools).toEqual([
      "tasks.read",
      "documents.search",
      "notion.page.append",
      "notion.page.create",
      "meetings.debrief",
      // ASH-285: drafting a Linear issue persists a proposal note - an
      // internal write that still fails closed without the grant.
      "linear.issue.propose",
      // ASH-282: proposing a calendar move persists a review card - an
      // internal write that still fails closed without the grant.
      "calendar.propose",
      "records.browse",
      "wiki.read",
      "wiki.ingest",
      "wiki.lint",
      "gmail.read",
      "gmail.thread.read",
      "github.read",
      "github.issue.read",
      // ASH-284: triage drafting persists a review-queue proposal - an
      // internal write, denied on every call without the grant.
      "github.issue.triage",
      "slack.channels.read",
      "slack.read",
      "linear.read",
      "linear.issue.read",
      "calendar.read",
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
      "tasks.create",
      "web.search",
      "web.fetch",
      "artifacts.revise",
      // The gained array carries the same instant.* names (spec #316).
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
    ]);
  });

  it("recorded search results come back per run, inside the workspace", async () => {
    const a = await workspace();
    const b = await workspace();
    const profileId = await ensureProfile(a.workspaceId);
    const [run] = await holder.db!.insert(agentRuns).values({
      workspaceId: a.workspaceId, agentProfileId: profileId, objective: "find rent", state: "running", policySnapshot: {},
    } as typeof agentRuns.$inferInsert).returning();
    await holder.db!.insert(toolCalls).values([
      { workspaceId: a.workspaceId, runId: run.id, toolName: "documents_search", ok: true, result: { ok: true, results: [{ documentId: "d", title: "T", text: "x", span: { start: 0, end: 1, page: 1 } }] } },
      { workspaceId: a.workspaceId, runId: run.id, toolName: "tasks_read", ok: true, result: { ok: true } },
      { workspaceId: a.workspaceId, runId: run.id, toolName: "documents_search", ok: false, result: null },
    ]);
    expect((await listDocumentSearchResults(a.workspaceId, [run.id])).get(run.id)).toHaveLength(1);
    expect((await listDocumentSearchResults(b.workspaceId, [run.id])).get(run.id)).toBeUndefined();
  });
});
