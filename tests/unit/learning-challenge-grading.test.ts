import { describe, expect, it } from "vitest";
import { challengeSteps, type ChallengeContent } from "@/domains/learning/challenge-content";
import { gradeByRules, isIndependent, namedLines } from "@/domains/learning/challenge-grading";

/*
 * The practice grader's contract: it says "correct" only when every step is
 * plainly met, calls a step wrong only on the known wrong answer or the wrong
 * line, and is "uncertain" about everything else. Pure, so it runs under the
 * unit project's fetch guard.
 */

const predict: ChallengeContent = {
  format: "predict",
  objective: "Decide whether a timed-out payment call is safe to send again",
  situation:
    "A client sends a charge request with an idempotency key. The response is lost to a timeout, so the client sends the same request again with the same key.",
  question: "What does the server do with the second request, and why?",
  outcome: {
    kind: "terms",
    accept: [["returns the stored result", "returns the first result", "same response", "does not charge again"]],
    reject: ["charges twice", "charges again", "second charge", "rejects the request"],
  },
  reason: {
    kind: "terms",
    accept: [["idempotency key", "same key"]],
    reject: [],
  },
  answer:
    "It returns the stored result of the first request and does not charge again, because the idempotency key shows it already handled this request.",
  rule: "A request repeated with the same idempotency key is answered from the first result and has no second effect.",
  hints: ["Think about what the key is for.", "The server has seen this key before.", "It replays the first result."],
};

const bugHunt: ChallengeContent = {
  format: "bug_hunt",
  objective: "Spot a side effect that is recorded after it happens",
  artifact: {
    kind: "code",
    lines: ["load checkpoint", "for step in remaining:", "  send_email(step)", "  save_checkpoint(step)", "done"],
  },
  question: "Which line goes wrong if the process stops at the worst moment, and which rule does it break?",
  fault: { kind: "lines", lines: [3] },
  invariant: {
    kind: "terms",
    accept: [
      ["record", "checkpoint", "save"],
      ["before", "first", "atomically"],
    ],
    reject: ["nothing is wrong"],
  },
  answer: "Line 3 sends the email before the step is saved, so the record must be written before or with the effect.",
  rule: "Record the intent before the side effect, so a restart cannot repeat it.",
  hints: ["Look at the order of the two lines in the loop.", "What happens between lines 3 and 4?", "Line 3 is early."],
};

const grade = (content: ChallengeContent, answer: string) => gradeByRules(challengeSteps(content), answer);

describe("gradeByRules", () => {
  it("is correct when every step is plainly met, and names no failed step", () => {
    const out = grade(predict, predict.answer);
    expect(out.grade).toBe("correct");
    expect(out.failedStep).toBeNull();
  });

  it("is incorrect on the known wrong answer and names the step", () => {
    const out = grade(predict, "The server charges twice since it sees two requests.");
    expect(out.grade).toBe("incorrect");
    expect(out.failedStep).toMatchObject({ id: "outcome", label: "what happens" });
  });

  it("is partial when one step is right and another states the wrong answer", () => {
    const out = grade(predict, "It sees the same key, and then it charges again.");
    expect(out.grade).toBe("partial");
    expect(out.failedStep?.id).toBe("outcome");
  });

  it("is uncertain, not incorrect, for a paraphrase the phrases do not cover", () => {
    const out = grade(predict, "Nothing new happens to the customer's card; the earlier outcome is handed back.");
    expect(out.grade).toBe("uncertain");
    expect(out.conflicted).toBe(false);
  });

  it("is uncertain and conflicted when an answer says both the right and the wrong thing", () => {
    const out = grade(predict, "It returns the stored result, but it also charges again, because of the same key.");
    expect(out.grade).toBe("uncertain");
    expect(out.conflicted).toBe(true);
  });

  it("does not count a negated right phrase as stated", () => {
    expect(grade(predict, "It will not return the same response; the same key is ignored.").grade).not.toBe("correct");
  });

  it("does not count a negated wrong phrase as the wrong answer", () => {
    const out = grade(predict, "It never charges twice: it returns the first result because of the same key.");
    expect(out.grade).toBe("correct");
  });

  it("never grades an empty or unrelated answer correct", () => {
    expect(grade(predict, "").grade).toBe("uncertain");
    expect(grade(bugHunt, "I think the loop looks fine to me.").grade).toBe("uncertain");
  });

  it("grades a bug hunt on the named line and the rule", () => {
    expect(grade(bugHunt, bugHunt.answer).grade).toBe("correct");
    const wrongLine = grade(bugHunt, "Line 2 is the problem: save the checkpoint before the loop.");
    expect(wrongLine.grade).toBe("partial");
    expect(wrongLine.failedStep?.label).toBe("where it goes wrong");
  });

  it("is uncertain when an answer names both the right line and another", () => {
    expect(grade(bugHunt, "Lines 3 and 5: the checkpoint should be saved first.").grade).toBe("uncertain");
  });
});

describe("namedLines", () => {
  it("reads single lines, lists and ranges", () => {
    expect(namedLines("line 4")).toEqual([4]);
    expect(namedLines("Lines 3-5 look wrong")).toEqual([3, 4, 5]);
    expect(namedLines("line 2 and 6, also L9")).toEqual([2, 6, 9]);
    expect(namedLines("the 3 retries on the second call")).toEqual([]);
  });
});

describe("isIndependent", () => {
  it("counts only a correct first try made without hints", () => {
    expect(isIndependent({ grade: "correct", hintsUsed: 0, ordinal: 0 })).toBe(true);
    expect(isIndependent({ grade: "correct", hintsUsed: 1, ordinal: 0 })).toBe(false);
    expect(isIndependent({ grade: "correct", hintsUsed: 0, ordinal: 1 })).toBe(false);
    expect(isIndependent({ grade: "partial", hintsUsed: 0, ordinal: 0 })).toBe(false);
    expect(isIndependent({ grade: null, hintsUsed: 0, ordinal: 0 })).toBe(false);
  });
});
