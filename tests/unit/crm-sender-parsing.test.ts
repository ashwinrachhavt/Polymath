import { describe, expect, it } from "vitest";
import { companyFromEmail, gmailThreadUrl, isAutomatedSender, nameFromEmail, parseSender } from "@/domains/crm/sender-parsing";
import { parseSenderPayload, SenderApprovalNotAllowedError } from "@/domains/crm/propose-from-senders";

describe("parseSender", () => {
  it("reads a display name and lowercases the address", () => {
    expect(parseSender('Ada Lovelace <Ada@Acme.com>')).toEqual({ email: "ada@acme.com", displayName: "Ada Lovelace" });
  });
  it("un-flips 'Last, First' and strips quotes", () => {
    expect(parseSender('"Lovelace, Ada" <ada@acme.com>')?.displayName).toBe("Ada Lovelace");
  });
  it("accepts a bare address with no name", () => {
    expect(parseSender("ada@acme.com")).toEqual({ email: "ada@acme.com", displayName: null });
  });
  it("drops a display name that is just an address", () => {
    expect(parseSender("ada@acme.com <ada@acme.com>")?.displayName).toBeNull();
  });
  it("neutralises control characters and caps the name", () => {
    const parsed = parseSender(`"${"A".repeat(400)}\n\u0000x" <a@b.co>`);
    expect(parsed?.displayName?.length).toBeLessThanOrEqual(120);
    expect(parsed?.displayName).not.toMatch(/[\n\u0000]/);
  });
  it("rejects missing and malformed headers", () => {
    expect(parseSender(null)).toBeNull();
    expect(parseSender("not an address")).toBeNull();
    expect(parseSender("Ada <ada@localhost>")).toBeNull();
  });
});

describe("isAutomatedSender", () => {
  it.each(["noreply@acme.com", "no-reply@acme.com", "notifications@github.com", "bounce+123@mail.acme.com", "mailer-daemon@x.com"])("flags %s", (e) =>
    expect(isAutomatedSender(e)).toBe(true),
  );
  // hello@/team@/billing@ at a small company are the owner of that company; a spurious card costs one tap.
  it.each(["ada@acme.com", "priya.sharma@acme.co.uk", "reply.guy@acme.com", "hello@acme.com", "team@acme.com", "billing@acme.com", "info@acme.com"])("keeps %s", (e) => expect(isAutomatedSender(e)).toBe(false));
});

describe("companyFromEmail", () => {
  it("derives name and registrable domain from a work address", () => {
    expect(companyFromEmail("ada@acme-labs.com")).toEqual({ domain: "acme-labs.com", name: "Acme Labs" });
  });
  it("strips subdomains", () => {
    expect(companyFromEmail("ada@eng.acme.com")).toEqual({ domain: "acme.com", name: "Acme" });
  });
  it("handles country-code second levels", () => {
    expect(companyFromEmail("ada@acme.co.uk")).toEqual({ domain: "acme.co.uk", name: "Acme" });
  });
  it("proposes no company for webmail", () => {
    expect(companyFromEmail("ada@gmail.com")).toBeNull();
  });
});

describe("helpers", () => {
  it("builds a name from the local part", () => {
    expect(nameFromEmail("priya.sharma+news@acme.com")).toBe("Priya Sharma");
  });
  it("encodes the thread id in the link", () => {
    expect(gmailThreadUrl("a/b#c")).toBe("https://mail.google.com/mail/u/0/#all/a%2Fb%23c");
  });
});

describe("parseSenderPayload", () => {
  const ok = { fullName: "Ada", email: "ada@acme.com", company: null, source: { provider: "gmail", messageId: "m", threadId: "t", threadUrl: "u", subject: null, receivedAt: null } };
  it("accepts a valid payload", () => expect(parseSenderPayload(ok).email).toBe("ada@acme.com"));
  it("refuses an owner edit that breaks the shape", () => {
    expect(() => parseSenderPayload({ ...ok, email: "nope" })).toThrow(SenderApprovalNotAllowedError);
    expect(() => parseSenderPayload({ ...ok, source: null })).toThrow(SenderApprovalNotAllowedError);
    expect(() => parseSenderPayload({ ...ok, company: { name: "", domain: "a.com" } })).toThrow(SenderApprovalNotAllowedError);
  });
});
