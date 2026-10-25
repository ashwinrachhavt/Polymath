import type { GenerationProvider, GenerateInput } from "./provider";
import { GenerationUnconfiguredError } from "./provider";

/*
 * The e2e fixture provider (GENERATION_PROVIDER=fixture): deterministic,
 * free, and local. It answers only the owner-invoked generation
 * surfaces by the marker phrase in their system prompts, so journeys can
 * click through the whole pipeline - debrief, prep, library draft, learning
 * path, profile research - without a model key or a cent of spend. Anything
 * else gets the honest unconfigured error, which callers already treat as a
 * skip.
 *
 * It is selectable only by an explicit env choice, never by key detection,
 * so no deployment drifts into it by accident.
 */

function debriefAnswer(): string {
  return JSON.stringify({
    tasks: [{ title: "Send the Q3 roadmap", description: "Priya asked for it by Friday." }],
    notes: [{ title: "Pricing decision", markdown: "**Decided:** annual billing stays for the platform tier." }],
    followUps: [{ summary: "confirm the launch date", person: "Marcus" }],
  });
}

function prepAnswer(): string {
  return JSON.stringify({
    summary: "Weekly sync with Priya Nair; the Q3 roadmap and launch date are the live items.",
    attendeeBriefs: [{ name: "Priya Nair", brief: "Platform lead; asked for the roadmap by Friday." }],
    history: "The pricing-decision note records that annual billing stays.",
    openLoops: "Send the Q3 roadmap is still open.",
    talkingPoints: ["Confirm the launch date", "Share the Q3 roadmap draft", "Reconfirm annual billing"],
  });
}

function writingAnswer(): string {
  return JSON.stringify({
    title: "Where pricing stands",
    paragraphs: [
      { text: "Annual billing stays for the platform tier, settled with Priya.", citations: [1], needsCitation: false },
      { text: "Whether usage pricing fits the next tier is still open.", citations: [], needsCitation: true },
    ],
  });
}

function learningPathAnswer(): string {
  return JSON.stringify({
    pathTitle: "Understanding distributed consensus",
    overview: "Start with why agreement is hard, learn Raft's shape, then drill the terms.",
    notes: [{ title: "Why consensus is hard", markdown: "Networks drop and delay messages; nodes crash. Agreement must survive both." }],
    practiceTasks: [{ title: "Sketch Raft's election on paper", description: "No notes, ten minutes." }],
    cards: [{ prompt: "What does a quorum prevent?", answer: "Two leaders deciding differently at the same time." }],
  });
}


function companyProfileAnswer(): string {
  return JSON.stringify({
    cards: [
      { kind: "overview", title: "Spending analytics for small teams", body: "Example builds spending analytics for small finance teams: statement imports, transaction categories and burn by vendor.", citations: [1] },
      { kind: "offerings", title: "Per-seat pricing with a free tier", body: "Pricing is per seat, free for two seats; the product positions against spreadsheets rather than enterprise suites.", citations: [1, 2] },
      { kind: "news", title: "Seed round to expand analytics", body: "Example raised $4M led by North Peak in October 2026 to expand its small-team spending analytics.", citations: [3] },
      { kind: "watch", title: "Eleven-person team, broad promise", body: "An eleven-person Portland team covers imports, categorization and reporting; depth per surface is the open question.", citations: [2] },
    ],
  });
}

function personProfileAnswer(): string {
  return JSON.stringify({
    cards: [
      { kind: "role", title: "Platform lead at Example", body: "Priya Nair leads the platform group at Example, owning pricing and billing infrastructure.", citations: [1] },
      { kind: "mentions", title: "On pricing analytics", body: "On a September podcast she argued small teams want pricing answers inside the tools they already use, not another dashboard.", citations: [2] },
      { kind: "talking-points", title: "Ask about the pricing launch", body: "Her team just shipped per-seat pricing; how the free tier converts is a natural opener.", citations: [1, 2] },
    ],
  });
}

export function fixtureProvider(): GenerationProvider {
  return {
    name: "fixture:e2e",
    registryId: "fixture",
    async generate(input: GenerateInput): Promise<{ text: string }> {
      const system = input.system ?? "";
      if (system.includes("debrief a meeting transcript")) return { text: debriefAnswer() };
      if (system.includes("meeting prep report")) return { text: prepAnswer() };
      if (system.includes("long-form writing")) return { text: writingAnswer() };
      if (system.includes("learning goal")) return { text: learningPathAnswer() };
      if (system.includes("company profile card set")) return { text: companyProfileAnswer() };
      if (system.includes("person profile card set")) return { text: personProfileAnswer() };
      throw new GenerationUnconfiguredError();
    },
  };
}
