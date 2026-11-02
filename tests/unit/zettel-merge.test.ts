import { describe, expect, it, vi } from "vitest";
import { mergeCandidates } from "@/domains/knowledge/zettel-merge";

const c = (title: string, claim: string, start: number) => ({
  title,
  claim,
  quote: `q-${title}`,
  start,
  end: start + 10,
  sectionIndex: 0,
});
const provider = (keep: number[]) => ({
  name: "test",
  generate: vi.fn(async () => ({ text: JSON.stringify({ keep }), usage: null })),
});

describe("mergeCandidates", () => {
  it("returns the input objects the model keeps, quotes untouched", async () => {
    const input = [c("A", "one", 0), c("B", "two", 20), c("C", "three", 40)];
    const out = await mergeCandidates(input, { provider: provider([0, 2]) as never });
    expect(out.map((x) => x.quote)).toEqual(["q-A", "q-C"]);
    expect(out[0]).toBe(input[0]);
  });
  it("cannot introduce a candidate the extractors did not produce", async () => {
    const input = [c("A", "one", 0)];
    const out = await mergeCandidates(input, { provider: provider([0, 7, 99]) as never });
    expect(out).toHaveLength(1);
  });
  it("caps the survivors at the source maximum", async () => {
    const input = Array.from({ length: 30 }, (_, i) => c(`I${i}`, `claim ${i}`, i * 10));
    const out = await mergeCandidates(input, { provider: provider(input.map((_, i) => i)) as never, max: 20 });
    expect(out).toHaveLength(20);
  });
  it("sends only titles and claims, never the quote text", async () => {
    const spy = provider([0]);
    await mergeCandidates([c("A", "one", 0)], { provider: spy as never });
    expect(JSON.stringify(spy.generate.mock.calls)).not.toContain("q-A");
  });
});
