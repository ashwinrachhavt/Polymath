import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The executor's outcome copy is a product rule, not a style preference: an
 * UNKNOWN effect says the system is checking, and a FAILED one never invites a
 * send again. Both are pinned in the source because the component is a client
 * island whose render needs a browser; what must never regress is the three
 * strings and the absence of the word "retry".
 */

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../src/app/(workspace)/reviews/reviews-queue.tsx"),
  "utf8",
);

describe("review outcome copy", () => {
  it("says Sent, Checking, and Not sent in the executor's vocabulary", () => {
    expect(SOURCE).toContain('return "Sent.";');
    expect(SOURCE).toContain('return "Checking whether this was sent.";');
    expect(SOURCE).toContain("return `Not sent. ${outcome.reason}`;");
  });

  it("never offers to retry an effect", () => {
    expect(SOURCE.toLowerCase()).not.toContain("retry");
  });
});
