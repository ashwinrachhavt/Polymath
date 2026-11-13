import { EVAL_TURNS } from "./turns";

/*
 * Recorded tool outputs for the agent eval.
 *
 * Every authored tool replays a recording: the real ones bind to a Polymath
 * run and a workspace the eval session does not have, and a real call would
 * fail closed in a way that measures the failure path, not the agent. The shapes
 * match what each tool returns in production (taken from `tool_calls` rows on
 * the laptop dev database, 2026-11-12). Library passages are written for the
 * eval, not copied: the repository is public and the owner's documents are not.
 * Web pages are short paraphrases of the pages the real runs fetched.
 */

type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type Json = { readonly [key: string]: JsonValue };

const LEASE_PASSAGES = [
  {
    documentId: "doc-lease-2026",
    title: "Apartment lease 2026",
    text: "Monthly rent is 2,400 and is due on the first of each month. Late payment after the fifth incurs a 75 fee.",
    span: { start: 1180, end: 1290 },
  },
  {
    documentId: "doc-lease-2026",
    title: "Apartment lease 2026",
    text: "The tenant pays a security deposit of 4,800. The landlord returns the deposit within 30 days of move-out, less itemised deductions for damage beyond normal wear.",
    span: { start: 2210, end: 2370 },
  },
  {
    documentId: "doc-lease-2026",
    title: "Apartment lease 2026",
    text: "The lease term runs from 1 February 2026 to 31 January 2027. Renewal notice is due 60 days before the end of the term.",
    span: { start: 410, end: 530 },
  },
];

const TRANSFORMER_PASSAGES = [
  {
    documentId: "doc-transformer-notes",
    title: "Transformer architecture notes",
    text: "Attention heads learn different relations: some track syntax (subject-verb), some track position, some copy tokens. Pruning studies show many heads can be removed with little loss.",
    span: { start: 0, end: 190 },
  },
  {
    documentId: "doc-transformer-notes",
    title: "Transformer architecture notes",
    text: "Positional encoding: sinusoidal encodings let the model generalise to longer sequences; rotary embeddings (RoPE) encode relative position by rotating query/key vectors.",
    span: { start: 640, end: 820 },
  },
];

const DAYBOOK_PASSAGES = [
  {
    documentId: "doc-daybook-2026-11-13",
    title: "Daybook 13 Nov",
    text: "Today: finish the agent routing eval, review the lease renewal clause, 30 minutes on backprop practice.",
    span: { start: 0, end: 105 },
  },
];

function passages(list: readonly Json[], query = "") {
  return {
    ok: true,
    mode: "hybrid",
    query,
    results: list.map((passage, index) => ({
      ...passage,
      extractionId: `ext-${String(passage.documentId)}`,
      chunkIndex: index,
      score: 0.82 - index * 0.05,
    })),
  };
}

const NO_PASSAGES = { ok: true, mode: "hybrid", query: "", results: [] };

function searchResults(results: readonly { url: string; title: string; snippet: string }[]) {
  return { ok: true, provider: "searxng", results: results.map((r) => ({ ...r, publishedAt: null })) };
}

function page(url: string, title: string, paragraphs: readonly string[]) {
  return { ok: true, url, title, markdown: `# ${title}\n\n${paragraphs.join("\n\n")}` };
}

const INTANGIBLE_SEARCH = searchResults([
  {
    url: "https://www.intangible.ai/technology",
    title: "Technology – Intangible",
    snippet:
      "Intangible is a creative platform for world models: generate and direct 3D worlds from text in the browser.",
  },
  {
    url: "https://techcrunch.com/2025/03/06/intangible-ai-a-no-code-3d-creation-tool-for-filmmakers-and-game-designers-raises-4m/",
    title: "Intangible AI, a no-code 3D creation tool for filmmakers and game designers, raises $4M",
    snippet:
      "Founded by former Apple and Unity people, Intangible lets creators block out 3D scenes with AI and export them to production tools.",
  },
  {
    url: "https://example.com/world-models-landscape",
    title: "The world model startup landscape",
    snippet:
      "World Labs, Decart and Odyssey lead a field of startups building models that generate interactive 3D environments.",
  },
]);

const INTANGIBLE_PAGE = page("https://www.intangible.ai/technology", "Technology – Intangible", [
  "Intangible describes its technology as an AI world model: a system that generates coherent, editable 3D worlds from text prompts and reference images.",
  "The product is a browser-based, no-code studio. Filmmakers, advertisers, event designers and game teams block out scenes, place cameras and characters, and export to Unreal, Blender or Unity.",
  "Intangible raised a 4M seed round in 2025. The founders previously built creative tools at Apple and Unity, and position the product as pre-visualisation that removes the 3D-modelling bottleneck.",
  "Demand comes from teams that need fast spatial concepting: previs for film, campaign concepts for agencies, and rapid level blockouts for games. The broader 3D content creation market is growing quickly as generative tools lower the skill barrier.",
  "Competitors at the model layer include World Labs, Decart and Odyssey; incumbents such as Unity, Epic and Adobe are adding generative features to their own tools.",
]);

const WORLD_MODELS_PAGE = page("https://www.nvidia.com/en-us/glossary/world-models/", "What are world models?", [
  "A world model is a learned representation of how an environment behaves. Given the current state and an action, it predicts the next state and often a reward.",
  "Agents use world models to plan by imagining the outcome of actions before taking them, which makes learning far more sample-efficient than trial and error alone.",
  "Modern world models generate video or 3D scenes conditioned on actions, and are used for robotics simulation, autonomous driving and interactive content.",
]);

const VIDEO_TRANSCRIPT = page("https://www.youtube.com/watch?v=Zl7n7RkT6rE", "World models, explained (transcript)", [
  "[00:00] Today: what a world model is. It is a model that learns how the world changes when you act in it.",
  "[01:10] Instead of reacting frame by frame, an agent with a world model can imagine several futures and pick the best action.",
  "[03:40] Examples: driving simulators trained on dashcam video, and game engines that are generated rather than programmed.",
  "[06:20] The open problems are long-horizon consistency and physical accuracy.",
]);

const VECTOR_DB_SEARCH = searchResults([
  {
    url: "https://github.com/pgvector/pgvector",
    title: "pgvector: open-source vector similarity search for Postgres",
    snippet:
      "Store vectors with the rest of your data. Supports exact and approximate nearest neighbour search with HNSW and IVFFlat indexes.",
  },
  {
    url: "https://qdrant.tech/documentation/overview/",
    title: "Qdrant documentation: overview",
    snippet:
      "Qdrant is a vector database and similarity search engine with payload filtering, quantization and a distributed mode.",
  },
]);

const VECTOR_DB_PAGE = page("https://qdrant.tech/documentation/overview/", "Qdrant documentation: overview", [
  "Qdrant is a dedicated vector database written in Rust. It offers rich payload filtering, scalar and binary quantization, and horizontal scaling.",
  "For small applications already running Postgres, an extension such as pgvector keeps vectors next to relational data, with one backup and one transaction model.",
]);

const OPEN_TASKS = {
  ok: true,
  tasks: [
    { id: "t1", title: "Review lease renewal clause", due: "2026-11-14", status: "open" },
    { id: "t2", title: "Prepare backprop quiz", due: "2026-11-15", status: "open" },
    { id: "t3", title: "Review PR on background jobs", due: null, status: "open" },
  ],
};

const PROPOSED = { ok: true, status: "awaiting_review", proposalId: "proposal-eval-1" };

/** The outcome each tool returns when a case sets nothing more specific. */
const DEFAULT_OUTCOMES: Record<string, Json> = {
  documents_search: NO_PASSAGES,
  web_search: searchResults([]),
  web_fetch: { ok: false, error: "page could not be read" },
  wiki_read: { ok: true, pages: [] },
  wiki_ingest: PROPOSED,
  wiki_lint: { ok: true, findings: [] },
  tasks_read: OPEN_TASKS,
  tasks_recent: { ok: true, tasks: [] },
  tasks_propose: PROPOSED,
  records_browse: { ok: true, results: [] },
  notebook_open: { ok: false, error: "no notebook is open in this conversation" },
  research_deepen: { ok: true, findings: [] },
  meeting_debrief: { ok: true, debrief: null },
  diagram: { ok: true, diagramId: "diagram-eval-1" },
  calendar_conflicts: { ok: false, error: "no calendar is connected" },
  calendar_conflict_propose: PROPOSED,
  connector_actions: { ok: true, actions: [] },
  crm_propose_contacts: PROPOSED,
  github_triage_propose: PROPOSED,
  notion_propose_update: PROPOSED,
  artifacts_propose_revision: PROPOSED,
  zettels_propose: PROPOSED,
  stones_propose: PROPOSED,
};

/** Case-specific outcomes, keyed by eval turn id, then tool. */
const CASE_OUTCOMES: Record<string, Record<string, Json>> = {
  "library-rent": { documents_search: passages(LEASE_PASSAGES.slice(0, 1), "rent") },
  "library-rent-in-lease": { documents_search: passages(LEASE_PASSAGES.slice(0, 1), "rent lease") },
  "library-summarize-leases": { documents_search: passages(LEASE_PASSAGES, "lease") },
  "library-deposit-followup": { documents_search: passages(LEASE_PASSAGES, "deposit") },
  "library-attention-notes": { documents_search: passages(TRANSFORMER_PASSAGES, "attention heads") },
  "library-daybook-today": {
    documents_search: passages(DAYBOOK_PASSAGES, "daybook today"),
    records_browse: {
      ok: true,
      results: [
        {
          kind: "note",
          title: "Daybook 13 Nov",
          excerpt: "Today: finish the agent routing eval, review the lease renewal clause.",
        },
      ],
    },
  },
  "tutor-quiz-my-notes": { documents_search: passages(TRANSFORMER_PASSAGES, "transformer") },
  "tutor-world-models": {
    web_search: searchResults([
      {
        url: "https://www.nvidia.com/en-us/glossary/world-models/",
        title: "What are world models?",
        snippet: "A world model predicts how an environment changes in response to actions.",
      },
    ]),
    web_fetch: WORLD_MODELS_PAGE,
  },
  "answer-video-summary": { web_fetch: VIDEO_TRANSCRIPT },
  "research-intangible": { web_search: INTANGIBLE_SEARCH, web_fetch: INTANGIBLE_PAGE },
  "research-bare-name": { web_search: INTANGIBLE_SEARCH, web_fetch: INTANGIBLE_PAGE },
  "research-map-to-intangible": { web_search: INTANGIBLE_SEARCH, web_fetch: INTANGIBLE_PAGE },
  "research-pgvector-qdrant": { web_search: VECTOR_DB_SEARCH, web_fetch: VECTOR_DB_PAGE },
  "draft-landlord-email": { documents_search: passages(LEASE_PASSAGES.slice(1, 2), "deposit") },
};

/**
 * The recordings the agent's eval fixture resolver replays
 * (agent/tools/eval_fixtures.ts), keyed by the user message that starts the
 * turn. A history turn that is itself an eval turn replays that turn's
 * recordings.
 */
export function fixtureTable(): { defaults: Record<string, Json>; cases: Record<string, Record<string, Json>> } {
  const cases: Record<string, Record<string, Json>> = {};
  for (const turn of EVAL_TURNS) cases[turn.text.trim()] = CASE_OUTCOMES[turn.id] ?? {};
  return { defaults: DEFAULT_OUTCOMES, cases };
}
