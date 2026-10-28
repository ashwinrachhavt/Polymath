import { describe, expect, it } from "vitest";
import {
  hasMentionContext,
  mentionedEntities,
  serializeMentionContext,
  stripMentionContext,
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
