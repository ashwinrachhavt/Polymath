/*
 * The agent eval set: 30 chat turns, each labelled with the lane it should
 * route to and whether answering it needs the owner's library.
 *
 * `source` says where a turn came from. "laptop-db" turns are the owner's real
 * messages from the local dev database (run_events, 2026-11-12), copied as
 * typed with no personal detail beyond what is shown. The laptop holds only a
 * dozen real turns, so the rest are "authored": written to cover the lanes the
 * real data lacks (greetings, drafting, operate, explain-a-change). The server
 * copy was not read.
 *
 * `library`: "required" means a good answer must search the owner's material;
 * "none" means searching it is wasted work; "optional" means either is fine.
 *
 * `history` turns are sent first to build the conversation and are not
 * measured; only `text` is.
 */
/** The shape of the work, as the router should classify it. */
export type TurnLane = "quick" | "answer" | "research" | "tutor" | "draft" | "operate" | "explain_change";

export type LibraryNeed = "required" | "none" | "optional";

export type EvalTurn = {
  id: string;
  source: "laptop-db" | "authored";
  history?: readonly string[];
  text: string;
  lane: TurnLane;
  library: LibraryNeed;
  /** What a good reply does, for the judge. */
  rubric: string;
};

export const EVAL_TURNS: readonly EvalTurn[] = [
  {
    id: "quick-hi",
    source: "authored",
    text: "hi",
    lane: "quick",
    library: "none",
    rubric: "A short, friendly greeting that invites the next request. No research, no long preamble.",
  },
  {
    id: "quick-thanks",
    source: "authored",
    text: "thanks, that's really helpful!",
    lane: "quick",
    library: "none",
    rubric: "A one- or two-sentence acknowledgement. No tool use, no new content.",
  },
  {
    id: "quick-morning",
    source: "authored",
    text: "good morning",
    lane: "quick",
    library: "none",
    rubric: "A brief greeting back.",
  },
  {
    id: "quick-still-thinking",
    source: "laptop-db",
    text: "Still thinking?",
    lane: "quick",
    library: "none",
    rubric: "A brief status reply; it does not start new research.",
  },
  {
    id: "quick-exact",
    source: "laptop-db",
    text: "Reply with exactly: recovery verified.",
    lane: "quick",
    library: "none",
    rubric: "The reply is the phrase 'recovery verified' and nothing substantive besides.",
  },
  {
    id: "answer-tcp-udp",
    source: "authored",
    text: "What's the difference between TCP and UDP?",
    lane: "answer",
    library: "none",
    rubric:
      "Correctly contrasts reliability/ordering/connection setup versus low-overhead datagrams, with typical uses. Concise.",
  },
  {
    id: "answer-spaced-repetition",
    source: "authored",
    text: "Explain spaced repetition in two sentences.",
    lane: "answer",
    library: "none",
    rubric: "Two sentences that correctly describe reviewing at increasing intervals to exploit the spacing effect.",
  },
  {
    id: "answer-quicksort",
    source: "authored",
    text: "Is quicksort O(n log n) in the worst case?",
    lane: "answer",
    library: "none",
    rubric: "Says no: worst case is O(n^2) (e.g. bad pivots on sorted input); average is O(n log n).",
  },
  {
    id: "library-rent",
    source: "laptop-db",
    text: "How much is my rent?",
    lane: "answer",
    library: "required",
    rubric: "States the rent of 2,400 per month due on the 1st, citing the lease document. Invents nothing.",
  },
  {
    id: "library-rent-in-lease",
    source: "laptop-db",
    text: "Find the rent in my lease",
    lane: "answer",
    library: "required",
    rubric: "Reports 2,400 per month from the lease, citing it.",
  },
  {
    id: "library-summarize-leases",
    source: "laptop-db",
    text: "Summarize my leases",
    lane: "answer",
    library: "required",
    rubric: "Summarizes the lease passages found (rent, term, deposit) with citations; does not invent other leases.",
  },
  {
    id: "library-deposit-followup",
    source: "laptop-db",
    history: ["Find the rent in my lease"],
    text: "Also check the deposit",
    lane: "answer",
    library: "required",
    rubric: "Reports the 4,800 security deposit and its return terms from the lease, citing it.",
  },
  {
    id: "library-attention-notes",
    source: "authored",
    text: "What did I write about attention heads in my transformer notes?",
    lane: "answer",
    library: "required",
    rubric:
      "Reports what the notes say (heads attend to different relations; some heads can be pruned) and cites them; labels anything beyond the notes as inference.",
  },
  {
    id: "library-daybook-today",
    source: "laptop-db",
    text: "What daybook entries exist for today? Reply in one sentence.",
    lane: "answer",
    library: "required",
    rubric:
      "One sentence about today's entries based on what the search found, or a plain statement that none were found. No invention.",
  },
  {
    id: "answer-tasks-summary",
    source: "laptop-db",
    text: "Summarise my tasks",
    lane: "answer",
    library: "none",
    rubric: "Summarises the open tasks returned by the task tool (lease renewal, quiz prep, PR review) accurately.",
  },
  {
    id: "answer-video-summary",
    source: "authored",
    text: "Summarize this video please https://www.youtube.com/watch?v=Zl7n7RkT6rE",
    lane: "answer",
    library: "none",
    rubric:
      "Summarizes the fetched transcript (world models learn environment dynamics to plan and imagine) without inventing content.",
  },
  {
    id: "research-intangible",
    source: "laptop-db",
    text: "Teach me what Intangible.ai does as a company. What is the problem space, what is the demand, who are the key players, where is this field heading, what is the market in this industry? What is Intangible doing that is special.",
    lane: "research",
    library: "none",
    rubric:
      "Explains Intangible as a no-code 3D/world-model creation platform, names the problem, demand, key players and direction, and attributes claims to the web sources read.",
  },
  {
    id: "research-pgvector-qdrant",
    source: "authored",
    text: "Compare pgvector and Qdrant for a small app, and cite sources.",
    lane: "research",
    library: "none",
    rubric:
      "A balanced comparison (operational simplicity of pgvector in Postgres vs dedicated features/perf of Qdrant) with sources named.",
  },
  {
    id: "research-map-to-intangible",
    source: "laptop-db",
    history: ["Help me understand World models and how they work please"],
    text: "How does it map with what intangible ai is doing?",
    lane: "research",
    library: "none",
    rubric:
      "Connects world-model concepts to Intangible's product (generating 3D worlds), grounded in fetched sources; does not confuse Intangible with another company.",
  },
  {
    id: "research-bare-name",
    source: "laptop-db",
    text: "Intangible.ai",
    lane: "research",
    library: "none",
    rubric: "Gives a short, sourced overview of Intangible.ai or asks one clarifying question; does not invent facts.",
  },
  {
    id: "tutor-world-models",
    source: "laptop-db",
    text: "Help me understand World models and how they work please",
    lane: "tutor",
    library: "optional",
    rubric:
      "A clear, structured explanation of world models (learned dynamics, prediction, planning/imagination) with an example; labels it general knowledge if not from the library.",
  },
  {
    id: "tutor-backprop",
    source: "authored",
    text: "Teach me how backpropagation works, step by step, and check I understood.",
    lane: "tutor",
    library: "none",
    rubric:
      "Step-by-step explanation (forward pass, loss, chain rule, gradients flowing backwards, update) and ends with a check-for-understanding question.",
  },
  {
    id: "tutor-quiz-my-notes",
    source: "authored",
    text: "Quiz me on my notes about the transformer architecture.",
    lane: "tutor",
    library: "required",
    rubric:
      "Asks quiz questions grounded in the notes found (attention heads, positional encoding), not generic trivia.",
  },
  {
    id: "draft-landlord-email",
    source: "authored",
    text: "Draft a short email to my landlord asking when my deposit will be returned.",
    lane: "draft",
    library: "optional",
    rubric: "A short, polite email draft asking about the deposit return timeline; does not claim it was sent.",
  },
  {
    id: "draft-ideas-from-conversation",
    source: "laptop-db",
    history: ["Help me understand World models and how they work please"],
    text: "Make ideas out of this conversation please",
    lane: "draft",
    library: "none",
    rubric:
      "Produces a handful of distinct idea notes drawn from the conversation, or proposes them for review; does not claim they were saved unless a tool said so.",
  },
  {
    id: "draft-blog-intro",
    source: "authored",
    text: "Write a 3-sentence intro for a blog post about learning in public.",
    lane: "draft",
    library: "none",
    rubric: "Exactly about three sentences, engaging, on learning in public.",
  },
  {
    id: "operate-create-task",
    source: "authored",
    text: "Create a task to review the lease renewal by Friday.",
    lane: "operate",
    library: "none",
    rubric:
      "Proposes the task (review the lease renewal, due Friday) and says it waits for approval; does not claim it already exists.",
  },
  {
    id: "operate-email-jamie",
    source: "authored",
    text: "Email Jamie the updated contract.",
    lane: "operate",
    library: "optional",
    rubric:
      "Does not claim the email was sent; either proposes a send for review or says mail is not connected and what would unblock it.",
  },
  {
    id: "explain-change-diff",
    source: "authored",
    text: 'Explain what this change does:\n\n```diff\n-const DEFAULT_ROUTING_TIMEOUT_MS = 1_500;\n+const DEFAULT_ROUTING_TIMEOUT_MS = 800;\n-  if (text.length < MIN_CLASSIFIABLE_CHARS) return { lane: "answer", routed: false, reason: "too_short" };\n+  if (text.length < MIN_CLASSIFIABLE_CHARS) return { lane: "quick", routed: true, reason: "rule" };\n```',
    lane: "explain_change",
    library: "none",
    rubric:
      "Explains both edits correctly: the routing timeout drops from 1.5s to 0.8s, and short messages now route to the quick lane as a rule decision instead of falling back to answer.",
  },
  {
    id: "explain-change-pr",
    source: "authored",
    text: "What changed in the background jobs system in PR #595 and why does it matter?",
    lane: "explain_change",
    library: "optional",
    rubric:
      "Does not invent PR contents: either explains from material it actually read or says what it would need (repository access) to answer.",
  },
];
