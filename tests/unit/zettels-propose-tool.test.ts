import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { toolAllowed } from "../../eve/polymath/agent/lib/policy";
import tool from "../../eve/polymath/agent/tools/zettels_propose";

// defineTool types inputSchema as a StandardSchema union; the authored value
// is a zod object, and the plan's assertions run against its safeParse.
const schema = tool.inputSchema as unknown as z.ZodType;

describe("zettels_propose", () => {
  it("tells the model the tool call is the acceptance", () => {
    expect(tool.description).toMatch(/create ideas/i);
    expect(tool.description).toMatch(/immediately/i);
    // The review queue is gone: no language may claim ideas wait for approval.
    expect(tool.description).not.toMatch(/review queue/i);
    expect(tool.description).not.toMatch(/does not create|nothing is created/i);
  });
  it("requires a stable dedupe id in its input", () => {
    expect(schema.safeParse({ text: "a body", dedupeId: "doc:123" }).success).toBe(true);
    expect(schema.safeParse({ text: "a body" }).success).toBe(false);
  });
  it("refuses when the capability is absent from the policy snapshot", () => {
    expect(toolAllowed({ allowedTools: ["tasks.read"] }, "zettels.propose")).toBe(false);
  });
});
