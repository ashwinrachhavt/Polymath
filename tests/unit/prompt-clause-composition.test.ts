import { afterEach, describe, expect, it, vi } from "vitest";
import { untrustedDataClause } from "@/lib/prompts";

/*
 * Value: protects=the hardened SYSTEM prompts actually carry the shared
 * untrusted-data clause at their public boundaries; fails_when=a refactor
 * drops or reorders the ${untrustedDataClause(...)} interpolation in any
 * composed prompt; why_new=prompts.test.ts covers the helper in isolation
 * only, so the exact drift the clause exists to prevent would ship silently;
 * seam=none (asserts through each module's real public entry — the fetch
 * stub observes the request body, no production seam added);
 * no_claim=provider acceptance (fetch stubbed; unit only).
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hardened prompts carry the shared clause", () => {
  it("wiki summarizer includes the clause in its system prompt", async () => {
    const { openRouterWikiSummarizer } = await import("@/integrations/wiki/summarizer");
    let system = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> };
        system = body.messages?.find((m) => m.role === "system")?.content ?? "";
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "t", summary: "s", body: "b", topics: ["x"] }) } }] }),
          { status: 200 },
        );
      }),
    );
    await openRouterWikiSummarizer({ OPENROUTER_API_KEY: "k" } as unknown as NodeJS.ProcessEnv).summarize("text", "doc");
    expect(system).toContain(untrustedDataClause("document"));
  });

  it("zettel extractor includes the clause in its system prompt", async () => {
    const { openRouterZettelExtractor } = await import("@/integrations/zettels/extractor");
    let system = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> };
        system = body.messages?.find((m) => m.role === "system")?.content ?? "";
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ zettels: [] }) } }] }),
          { status: 200 },
        );
      }),
    );
    await openRouterZettelExtractor({ OPENROUTER_API_KEY: "k" } as unknown as NodeJS.ProcessEnv).extract("text");
    expect(system).toContain(untrustedDataClause("document"));
  });

  it("company research section writer includes the clause in its system prompt", async () => {
    const { SECTION_SYSTEM } = await import("@/domains/knowledge/company-research");
    expect(SECTION_SYSTEM).toContain(untrustedDataClause("brief"));
  });

  it("KPI extraction rules include the clause", async () => {
    const { KPI_SYSTEM_RULES } = await import("@/domains/knowledge/research-kpis");
    expect(KPI_SYSTEM_RULES).toContain(untrustedDataClause("sources"));
  });
});
