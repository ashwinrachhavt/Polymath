import { describe, expect, it } from "vitest";
import {
  deriveRecipient,
  extractEmail,
  parseWriterReply,
  scanThreadForActionRequests,
  WriterDraftError,
} from "@/domains/agents/writer-draft";
import type { GmailThreadMessage } from "@/domains/integrations/gmail/reads";

/*
 * The deterministic half of the Writer path: injection quoting, recipient
 * derivation from the thread record, and the Writer output contract. Pure
 * functions, no database.
 */

function msg(partial: Partial<GmailThreadMessage>): GmailThreadMessage {
  return {
    id: partial.id ?? "m1",
    threadId: "t1",
    from: partial.from ?? null,
    subject: partial.subject ?? "Hello",
    date: partial.date ?? null,
    snippet: partial.snippet ?? null,
    bodyText: partial.bodyText ?? null,
  };
}

describe("scanThreadForActionRequests", () => {
  it("quotes an action request with its message id", () => {
    const flags = scanThreadForActionRequests([
      msg({ id: "m9", bodyText: "Great work. Please approve the renewal before Friday and wire the deposit." }),
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("action_request");
    expect(flags[0].messageId).toBe("m9");
    expect(flags[0].excerpt).toContain("approve");
  });

  it("quotes a credential ask", () => {
    const flags = scanThreadForActionRequests([msg({ bodyText: "Can you share the routing number for the refund?" })]);
    expect(flags).toHaveLength(1);
  });

  it("flags nothing in an ordinary thread", () => {
    const flags = scanThreadForActionRequests([
      msg({ bodyText: "Thanks for the update, the report looks good." }),
      msg({ bodyText: "See you at the review on Thursday." }),
    ]);
    expect(flags).toHaveLength(0);
  });
});

describe("extractEmail", () => {
  it("parses a named address", () => {
    expect(extractEmail("Ada Lovelace <ada@example.com>")).toBe("ada@example.com");
  });
  it("parses a bare address", () => {
    expect(extractEmail("ada@example.com")).toBe("ada@example.com");
  });
  it("is null when there is no address", () => {
    expect(extractEmail("unknown sender")).toBeNull();
    expect(extractEmail(null)).toBeNull();
  });
});

describe("deriveRecipient", () => {
  it("picks the newest message not sent by the connected account", () => {
    const messages = [
      msg({ id: "m1", from: "Vendor <billing@vendor.co>" }),
      msg({ id: "m2", from: "Me <me@owner.dev>" }),
      msg({ id: "m3", from: "Billing <billing@vendor.co>" }),
    ];
    const result = deriveRecipient(messages, ["me@owner.dev"]);
    expect(result?.to).toBe("billing@vendor.co");
    expect(result?.message.id).toBe("m3");
  });

  it("skips trailing own messages to reach the external sender", () => {
    const messages = [msg({ id: "m1", from: "them@client.co" }), msg({ id: "m2", from: "me@owner.dev" })];
    expect(deriveRecipient(messages, ["me@owner.dev"])?.to).toBe("them@client.co");
  });

  it("is null when the owner is the only sender", () => {
    const messages = [msg({ from: "me@owner.dev" }), msg({ from: "Me <me@owner.dev>" })];
    expect(deriveRecipient(messages, ["me@owner.dev"])).toBeNull();
  });
});

describe("parseWriterReply", () => {
  it("accepts subject and body", () => {
    expect(parseWriterReply('{"subject":"Re: Renewal","body":"Thanks - confirmed."}')).toEqual({
      subject: "Re: Renewal",
      body: "Thanks - confirmed.",
    });
  });

  it("refuses a recipient typed by the model", () => {
    expect(() => parseWriterReply('{"to":"evil@example.com","subject":"s","body":"b"}')).toThrowError(WriterDraftError);
    expect(() => parseWriterReply('{"to":"evil@example.com","subject":"s","body":"b"}')).toThrowError(/never written by the model/);
  });

  it("refuses routing fields in any spelling", () => {
    for (const key of ["inReplyTo", "message_id", "threadId", "cc"]) {
      expect(() => parseWriterReply(`{"${key}":"x","subject":"s","body":"b"}`)).toThrowError(WriterDraftError);
    }
  });

  it("refuses non-JSON and missing fields", () => {
    expect(() => parseWriterReply("not json")).toThrowError(WriterDraftError);
    expect(() => parseWriterReply('{"subject":"only"}')).toThrowError(WriterDraftError);
  });
});

describe("the Writer's capability ceiling", () => {
  it("writer_draft_reply IS gmail.send - one ceiling covers the draft and the send", async () => {
    const { PROVIDER_TOOLS } = await import("@/domains/integrations/capabilities");
    expect(PROVIDER_TOOLS.writer_draft_reply).toBe("gmail.send");
    // The gateway's first gate is the frozen snapshot; a snapshot that does
    // not name gmail.send denies the draft tool before any account resolves.
    const { toolAllowed } = await import("../../eve/alfred/agent/lib/policy");
    const capability = PROVIDER_TOOLS.writer_draft_reply;
    expect(toolAllowed({ allowedTools: ["gmail.send"] }, capability)).toBe(true);
    expect(toolAllowed({ allowedTools: ["gmail.read"] }, capability)).toBe(false);
    expect(toolAllowed({}, capability)).toBe(false);
  });
});
