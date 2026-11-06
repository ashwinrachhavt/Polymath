import { describe, expect, it } from "vitest";
import { withMaxOutputTokens } from "@/domains/agents/model-output-limit";

describe("withMaxOutputTokens", () => {
  it("caps provider limits for streaming and non-streaming calls", async () => {
    const calls: number[] = [];
    const model = {
      async doGenerate(options: { maxOutputTokens?: number }) {
        calls.push(options.maxOutputTokens ?? 0);
        return "generated";
      },
      async doStream(options: { maxOutputTokens?: number }) {
        calls.push(options.maxOutputTokens ?? 0);
        return "stream";
      },
    };

    const limited = withMaxOutputTokens(model, 12_000);
    await limited.doGenerate({ maxOutputTokens: 16_000 });
    await limited.doStream({ maxOutputTokens: 8_000 });

    expect(calls).toEqual([12_000, 8_000]);
  });

  it("sets a limit when the runtime does not supply one", async () => {
    let received = 0;
    const model = {
      async doStream(options: { maxOutputTokens?: number }) {
        received = options.maxOutputTokens ?? 0;
      },
    };

    await withMaxOutputTokens(model, 12_000).doStream({});
    expect(received).toBe(12_000);
  });
});
