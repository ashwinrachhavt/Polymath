import { and, desc, eq, inArray } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import type { WebSearchResult } from "@/integrations/search/provider";
import { db } from "@/lib/db";
import { artifactLinks, artifacts } from "./schema";
import { searchDocumentsForAgent } from "./agent-search";
import { searchWebForAgent } from "./web-search";

/*
 * ASH-293: a deep dive expands the research graph one hop at a time, and the
 * remaining budget stays visible the whole way.
 *
 * The budget is counted in hops and, under that, in paid search calls — because
 * the two stops mean different things. Running out of *hops* is a normal end to
 * a deep dive ("that is as far as this budget goes"). Running out of *provider
 * allowance* is a metered stop with nothing to do with the question. Every hop
 * reports both, so the caller never has to infer why research stopped.
 *
 * One hop expands the frontier node two ways, cheapest first: edges the library
 * already holds (free, and better evidence than a fresh web result), then
 * outward searches (paid) only when the graph had nothing new. That ordering
 * means a well-connected library deep-dives a long way before spending.
 *
 * Web hits are returned as candidates, never as nodes. This graph is made of
 * artifacts, and minting artifacts from search results would drop unread pages
 * into the owner's library behind their back.
 */

export const DEEP_DIVE_MAX_HOPS = 8;
export const DEEP_DIVE_NODES_PER_HOP = 3;
export const DEEP_DIVE_SEARCHES_PER_NODE = 1;
export const DEEP_DIVE_CANDIDATES_PER_SEARCH = 3;

export type ResearchBudget = {
  hopsUsed: number;
  hopsRemaining: number;
  hopsMax: number;
  /** Paid search calls this dive has made. */
  callsUsed: number;
  /** Null when no cap was set; a number when the run or the caller imposed one. */
  callsMax: number | null;
};

export type ResearchNode = {
  artifactId: string;
  title: string;
  /** 1 for the first hop out from the seed. */
  depth: number;
  /** The passage or link label that justified the edge. */
  via: string | null;
};

/** A web page worth reading, not yet part of the graph. */
export type ResearchCandidate = WebSearchResult & { fromArtifactId: string };

export type HopStop = "budget" | "exhausted" | "provider_limit";

export type HopResult =
  | {
      ok: true;
      seed: ResearchNode;
      added: ResearchNode[];
      candidates: ResearchCandidate[];
      budget: ResearchBudget;
      /** Why the hop produced no nodes or stopped early; null when it grew the graph. */
      stoppedBecause: HopStop | null;
    }
  | { ok: false; error: string };

export type HopInput = {
  /** Expand from a node the dive already has. */
  fromArtifactId?: string;
  /** ...or start from a question, which resolves to its best-matching node first. */
  query?: string;
  hopsUsed: number;
  callsUsed: number;
  /** A cap can only lower the defaults. */
  hopsMax?: number;
  callsMax?: number;
};

export function budgetOf(input: { hopsUsed: number; callsUsed: number; hopsMax?: number; callsMax?: number }): ResearchBudget {
  const hopsMax = Math.min(input.hopsMax ?? DEEP_DIVE_MAX_HOPS, DEEP_DIVE_MAX_HOPS);
  return {
    hopsUsed: input.hopsUsed,
    hopsRemaining: Math.max(0, hopsMax - input.hopsUsed),
    hopsMax,
    callsUsed: input.callsUsed,
    callsMax: input.callsMax ?? null,
  };
}

/**
 * One hop. Reads the seed's existing edges, then searches outward when the
 * edges yielded nothing. Nothing is written: a dive the owner abandons leaves
 * no rows behind, and keeping a node is a separate, explicit act.
 */
export async function expandResearchHop(auth: AuthContext, input: HopInput): Promise<HopResult> {
  const budget = budgetOf(input);
  if (budget.hopsRemaining === 0) {
    return { ok: false, error: `This deep dive has used all ${budget.hopsMax} hops. Start a new dive to keep going.` };
  }

  const seedResult = await resolveSeed(auth, input);
  if (!seedResult.ok) return seedResult;
  const seed = seedResult.seed;

  const { nodes, candidates, callsUsed, stoppedBecause } = await expandFrom(auth, seed, input);

  return {
    ok: true,
    seed,
    added: nodes,
    candidates,
    budget: budgetOf({ ...input, callsUsed }),
    // A hop that found nothing is not a failure; it says why it found nothing.
    stoppedBecause: nodes.length > 0 ? null : (stoppedBecause ?? "exhausted"),
  };
}

async function resolveSeed(auth: AuthContext, input: HopInput): Promise<{ ok: true; seed: ResearchNode } | { ok: false; error: string }> {
  if (input.fromArtifactId) {
    const [row] = await db
      .select({ id: artifacts.id, title: artifacts.title })
      .from(artifacts)
      .where(and(eq(artifacts.id, input.fromArtifactId), eq(artifacts.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!row) return { ok: false, error: "That node does not exist in this workspace." };
    return { ok: true, seed: { artifactId: row.id, title: row.title, depth: 0, via: null } };
  }

  const query = input.query?.trim();
  if (!query) return { ok: false, error: "Give a node to expand or a question to start from." };
  const found = await searchDocumentsForAgent(auth, { query, limit: 1 });
  if (!found.ok) return { ok: false, error: found.error };
  const first = found.results[0];
  if (!first) return { ok: false, error: `Nothing in the library matches “${query}”.` };
  return { ok: true, seed: { artifactId: first.documentId, title: first.title, depth: 0, via: null } };
}

async function expandFrom(
  auth: AuthContext,
  seed: ResearchNode,
  input: HopInput,
): Promise<{ nodes: ResearchNode[]; candidates: ResearchCandidate[]; callsUsed: number; stoppedBecause: HopStop | null }> {
  const depth = input.hopsUsed + 1;

  // The library's own edges: free, and evidence the owner already collected.
  const edges = await db
    .select({
      targetId: artifactLinks.targetId,
      targetType: artifactLinks.targetType,
      label: artifactLinks.label,
      context: artifactLinks.context,
    })
    .from(artifactLinks)
    .where(and(eq(artifactLinks.workspaceId, auth.workspaceId), eq(artifactLinks.artifactId, seed.artifactId)))
    .orderBy(desc(artifactLinks.score), desc(artifactLinks.createdAt))
    .limit(DEEP_DIVE_NODES_PER_HOP * 2);

  const linkedIds = edges
    .filter((edge) => edge.targetType === "artifact" && edge.targetId !== seed.artifactId)
    .map((edge) => edge.targetId)
    .slice(0, DEEP_DIVE_NODES_PER_HOP);

  if (linkedIds.length > 0) {
    const titles = await db
      .select({ id: artifacts.id, title: artifacts.title })
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), inArray(artifacts.id, linkedIds)));
    const titleById = new Map(titles.map((row) => [row.id, row.title]));
    const nodes = linkedIds
      .filter((id) => titleById.has(id))
      .map((id) => {
        const edge = edges.find((candidate) => candidate.targetId === id);
        return { artifactId: id, title: titleById.get(id)!, depth, via: edge?.context ?? edge?.label ?? null };
      });
    // A graph with edges is a complete hop: spending a search to confirm what
    // the library already established would be paying for a worse answer.
    if (nodes.length > 0) return { nodes, candidates: [], callsUsed: input.callsUsed, stoppedBecause: null };
  }

  // Nothing new in the library, so look outward — within the call cap.
  if (input.callsMax !== null && input.callsMax !== undefined && input.callsUsed >= input.callsMax) {
    return { nodes: [], candidates: [], callsUsed: input.callsUsed, stoppedBecause: "budget" };
  }

  const searches = Math.min(DEEP_DIVE_SEARCHES_PER_NODE, (input.callsMax ?? Number.POSITIVE_INFINITY) - input.callsUsed);
  let callsUsed = input.callsUsed;
  const candidates: ResearchCandidate[] = [];
  let stoppedBecause: HopStop | null = null;

  for (let i = 0; i < searches; i += 1) {
    const found = await searchWebForAgent(auth, { query: seed.title, limit: DEEP_DIVE_CANDIDATES_PER_SEARCH });
    callsUsed += 1;
    if (!found.ok) {
      // A provider stop is not an empty answer, and the caller is told which.
      stoppedBecause = "provider_limit";
      break;
    }
    candidates.push(...found.results.map((result) => ({ ...result, fromArtifactId: seed.artifactId })));
  }

  return { nodes: [], candidates, callsUsed, stoppedBecause };
}
