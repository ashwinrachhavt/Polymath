import { describe, expect, it } from "vitest";
import {
  fitMentionContext,
  hasMentionContext,
  mentionedEntities,
  resolveMentionPayload,
  serializeMentionContext,
  stripMentionContext,
  MAX_CONTEXT_BLOCK_CHARS,
  MAX_CONTEXT_FIELD_CHARS,
  MAX_TOTAL_CONTEXT_CHARS,
  truncateForContext,
  type MentionEntity,
} from "@/components/chat/mention-context";

/*
 * The mention context contract: picked entities ride out of band, appended to
 * the model's copy of the message as a one-line JSON block, and stripped at
 * every render path. The strip must never eat prose that merely quotes
 * brackets, and a block's own JSON must never leak into a title.
 */

const company: MentionEntity = { id: "b0000000-0000-0000-0000-000000000001", kind: "company", title: "Abby Care", href: "/command-center/relationships/companies/b0000000-0000-0000-0000-000000000001" };
const person: MentionEntity = { id: "p0000000-0000-0000-0000-000000000002", kind: "person", title: "Dana Whitfield", href: "/command-center/relationships/contacts?id=p0000000-0000-0000-0000-000000000002" };

describe("mention context", () => {
  it("keeps only the entities the message still names", () => {
    const text = "Ask @Abby Care about the roadmap; Dana can wait.";
    expect(mentionedEntities([company, person], text)).toEqual([company]);
  });

  it("serializes one compact block per entity and strips it back out", () => {
    const entries = [{ entity: company, context: { id: company.id, name: "Abby Care", people: [{ name: "Xiaoyu Miao" }] } }];
    const payload = `What is the status?${serializeMentionContext(entries)}`;
    expect(hasMentionContext(payload)).toBe(true);
    expect(stripMentionContext(payload)).toBe("What is the status?");
  });

  it("strips multiple blocks", () => {
    const entries = [
      { entity: company, context: { id: company.id } },
      { entity: person, context: { id: person.id } },
    ];
    const payload = `Intro${serializeMentionContext(entries)}`;
    expect(stripMentionContext(payload)).toBe("Intro");
  });

  it("leaves prose that quotes brackets untouched", () => {
    const text = 'The config [not-a-context id=x]\n{"keep": "me"} stays visible.';
    expect(stripMentionContext(text)).toBe(text);
    expect(hasMentionContext(text)).toBe(false);
  });

  it("keeps a typed follow-up sentence after a block", () => {
    const entries = [{ entity: person, context: { id: person.id } }];
    const payload = `Intro${serializeMentionContext(entries)}\nand one more thing`;
    expect(stripMentionContext(payload)).toBe("Intro\nand one more thing");
  });

  it("serializes nothing for an empty list", () => {
    expect(serializeMentionContext([])).toBe("");
  });
});

describe("mention context budget", () => {
  it("clamps a long note so the payload stays under the budget", () => {
    const note = "x".repeat(10_000);
    const payload = serializeMentionContext([{ entity: company, context: { id: company.id, notes: note } }]);
    expect(payload.length).toBeLessThanOrEqual(MAX_CONTEXT_FIELD_CHARS + 200);
    expect(payload).toContain("…");
    expect(stripMentionContext(`Question?${payload}`)).toBe("Question?");
  });

  it("drops a whole block that still exceeds the block budget after clamping", () => {
    // Many distinct long fields: clamped each to MAX_CONTEXT_FIELD_CHARS, the
    // joined payload still passes the block budget, so the block is dropped.
    const context = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`field${i}`, "y".repeat(MAX_CONTEXT_FIELD_CHARS)]),
    );
    const payload = serializeMentionContext([{ entity: company, context }]);
    expect(payload).toBe("");
  });

  it("stops adding blocks once the total budget is reached", () => {
    // Three field-clamped blocks of roughly 1700 chars each: the first two
    // fit the 4000 total, the third is skipped in call order.
    const wide = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`field${i}`, "z".repeat(MAX_CONTEXT_FIELD_CHARS)]),
    );
    const third: MentionEntity = { id: "c0000000-0000-0000-0000-000000000005", kind: "company", title: "Third Co", href: "/z" };
    const payload = serializeMentionContext([
      { entity: company, context: wide },
      { entity: person, context: wide },
      { entity: third, context: wide },
    ]);
    expect(payload).toContain(company.id);
    expect(payload).toContain(person.id);
    expect(payload).not.toContain(third.id);
    expect(payload.length).toBeLessThanOrEqual(MAX_TOTAL_CONTEXT_CHARS + 100);
  });

  it("truncateForContext marks the cut with an ellipsis", () => {
    expect(truncateForContext("short", 10)).toBe("short");
    expect(truncateForContext("a".repeat(30), 10)).toBe(`${"a".repeat(10)}…`);
  });

  it("fitMentionContext sheds whole blocks, never typed text", () => {
    const entries = [
      { entity: company, context: { id: company.id, notes: "n".repeat(400) } },
      { entity: person, context: { id: person.id, notes: "m".repeat(400) } },
    ];
    const message = `Typed words${serializeMentionContext(entries)}`;
    const fitted = fitMentionContext(message, 600);
    expect(fitted.startsWith("Typed words")).toBe(true);
    expect(fitted).toContain(company.id);
    expect(fitted).not.toContain(person.id);
    expect(fitted.length).toBeLessThanOrEqual(600);
    expect(stripMentionContext(fitted)).toBe("Typed words");
  });

  it("fitMentionContext keeps the typed text even when it alone exceeds the cap", () => {
    const typed = "q".repeat(700);
    const message = `${typed}${serializeMentionContext([{ entity: company, context: { id: company.id } }])}`;
    expect(fitMentionContext(message, 500)).toBe(typed);
  });

  it("fitMentionContext leaves a message that already fits untouched", () => {
    const message = `Hello${serializeMentionContext([{ entity: company, context: { id: company.id } }])}`;
    expect(fitMentionContext(message, MAX_CONTEXT_BLOCK_CHARS * 10)).toBe(message);
  });

  it("exposes the budget constants the action and route align on", () => {
    expect(MAX_CONTEXT_BLOCK_CHARS).toBe(2000);
    expect(MAX_TOTAL_CONTEXT_CHARS).toBe(4000);
  });
});

describe("mention context format", () => {
  it("round-trips a title containing a closing bracket", () => {
    const entity: MentionEntity = { ...person, title: "Dana ] [Weird]" };
    const payload = `Intro${serializeMentionContext([{ entity, context: { id: entity.id } }])}`;
    expect(payload).toContain("Dana ] [Weird]");
    expect(stripMentionContext(payload)).toBe("Intro");
  });

  it("round-trips a title containing a newline", () => {
    const entity: MentionEntity = { ...person, title: "Dana\nWhitfield" };
    const payload = `Intro${serializeMentionContext([{ entity, context: { id: entity.id } }])}`;
    expect(stripMentionContext(payload)).toBe("Intro");
  });

  it("carries name and kind in the JSON payload, not the header", () => {
    const payload = serializeMentionContext([{ entity: company, context: { id: company.id } }]);
    expect(payload).toContain("[context:mention id=b0000000-0000-0000-0000-000000000001]");
    expect(payload).toContain(`"name":"Abby Care"`);
    expect(payload).toContain(`"kind":"company"`);
    expect(payload).not.toContain("kind=company");
    expect(payload).not.toContain("name=Abby Care");
  });

  it("still strips an old-format block whose title has no bracket", () => {
    const old = `\n[context:mention id=${company.id} kind=company name=Abby Care]\n{"id":"${company.id}"}`;
    expect(stripMentionContext(`Intro${old}`)).toBe("Intro");
  });
});

describe("exact mention matching", () => {
  const ann: MentionEntity = { id: "a0000000-0000-0000-0000-000000000003", kind: "person", title: "Ann", href: "/x" };
  const annSmith: MentionEntity = { id: "a0000000-0000-0000-0000-000000000004", kind: "person", title: "Ann Smith", href: "/y" };

  it("does not match Ann Smith when only Ann is the entity and the text names Ann Smith", () => {
    // "@Ann Smith" names Ann Smith; "@Ann" alone would match Ann.
    expect(mentionedEntities([ann], "Ping @Ann Smith please")).toEqual([]);
  });

  it("matches the full name as its own mention", () => {
    expect(mentionedEntities([annSmith], "Ping @Ann Smith please")).toEqual([annSmith]);
  });

  it("matches a short name only at a word boundary", () => {
    expect(mentionedEntities([ann], "Ping @Ann!")).toEqual([ann]);
    expect(mentionedEntities([ann], "Ping @Anna")).toEqual([]);
    expect(mentionedEntities([ann], "email@Ann")).toEqual([]);
    expect(mentionedEntities([ann], "@Ann")).toEqual([ann]);
  });

  it("prefers the longer entity when both could match", () => {
    expect(mentionedEntities([ann, annSmith], "Ping @Ann Smith please")).toEqual([annSmith]);
    expect(mentionedEntities([ann, annSmith], "Ping @Ann please")).toEqual([ann]);
  });
});

describe("resolveMentionPayload", () => {
  const fetcher = async (input: { kind: string; id: string }) =>
    input.id === company.id ? { id: company.id, name: "Abby Care" } : null;

  it("appends serialized blocks for the entities the text still names", async () => {
    const message = await resolveMentionPayload([company, person], "Ask @Abby Care", fetcher as never);
    expect(message.startsWith("Ask @Abby Care")).toBe(true);
    expect(message).toContain(company.id);
    expect(message).not.toContain(person.id);
    expect(stripMentionContext(message)).toBe("Ask @Abby Care");
  });

  it("returns the text untouched when no entity is named or resolves", async () => {
    expect(await resolveMentionPayload([company], "No mentions here", fetcher as never)).toBe("No mentions here");
    expect(await resolveMentionPayload([person], "Ask @Dana Whitfield", fetcher as never)).toBe("Ask @Dana Whitfield");
  });
});
