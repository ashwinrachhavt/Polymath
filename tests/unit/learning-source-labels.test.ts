import { describe, expect, it } from "vitest";
import { quizHeading, sourceLabels, sourcesLine } from "@/domains/learning/source-labels";

/*
 * What a quiz calls its sources. The owner's quiz read eight pasted docs
 * pages whose stored title was the same raw first line, so its heading was
 * "> ## Documentation Index + 7 more" and its subtitle that title eight times.
 *
 * Value: protects=a source name never shows markdown, and sources are told
 * apart or counted, never repeated; fails_when=raw markers reach a name, a
 * title someone chose is replaced, or a shared name is listed once per
 * source; seam=the pure labelling functions; no_claim=loading the sources.
 */

const NOTICE =
  "> ## Documentation Index\n> Fetch the complete documentation index at: https://docs.example.test/llms.txt\n\n";
const page = (heading: string) => ({
  title: "> ## Documentation Index",
  text: `${NOTICE}# ${heading}\n\nSome explanation of ${heading}.`,
});

describe("sourceLabels", () => {
  it("strips markdown from a stored title", () => {
    expect(sourceLabels([{ title: "> ## Documentation Index" }])).toEqual(["Documentation Index"]);
    expect(sourceLabels([{ title: "**[Fetch](https://x.test/fetch)** notes" }])).toEqual(["Fetch notes"]);
  });

  it("names a source by its own heading when its stored title is only its first line", () => {
    expect(sourceLabels([page("Example Servers"), page("TUI client")])).toEqual(["Example Servers", "TUI client"]);
  });

  it("keeps a title someone chose", () => {
    const chosen = { title: "My MCP reading", text: `${NOTICE}# Example Servers\n\nText.` };
    expect(sourceLabels([chosen])).toEqual(["My MCP reading"]);
  });

  it("tells same-named sources apart by site", () => {
    const labels = sourceLabels([
      { title: "Pricing", sourceUrl: "https://www.alpha.test/pricing" },
      { title: "Pricing", sourceUrl: "https://beta.test/pricing" },
      { title: "Roadmap", sourceUrl: "https://beta.test/roadmap" },
    ]);
    expect(labels).toEqual(["Pricing (alpha.test)", "Pricing (beta.test)", "Roadmap"]);
  });

  it("falls back to the day saved when the site is the same or missing", () => {
    const labels = sourceLabels([
      { title: "Standup", createdAt: new Date("2026-11-10T09:00:00Z") },
      { title: "Standup", createdAt: new Date("2026-11-11T09:00:00Z") },
    ]);
    expect(labels).toEqual(["Standup (Nov 10)", "Standup (Nov 11)"]);
  });

  it("leaves sources nothing tells apart with one shared name", () => {
    const same = { title: "Documentation Index", createdAt: new Date("2026-11-12T02:00:00Z") };
    expect(sourceLabels([same, same])).toEqual(["Documentation Index", "Documentation Index"]);
  });
});

describe("quizHeading and sourcesLine", () => {
  const eight = Array.from({ length: 8 }, () => "Documentation Index");

  it("counts a shared name instead of repeating it", () => {
    expect(quizHeading(eight)).toBe("Documentation Index (8 sources)");
    expect(sourcesLine(eight)).toBe("From 8 sources: Documentation Index (8)");
  });

  it("names the first source and how many other names follow", () => {
    const labels = ["Example Servers", "TUI client", "TUI client", "Web client"];
    expect(quizHeading(labels)).toBe("Example Servers + 2 more");
    expect(sourcesLine(labels)).toBe("From 4 sources: Example Servers, TUI client (2), Web client");
  });

  it("titles a one-source quiz after its source", () => {
    expect(quizHeading(["Example Servers"])).toBe("Example Servers");
  });
});
