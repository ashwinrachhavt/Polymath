import { describe, expect, it } from "vitest";
// The extension ships plain scripts; the state machine is exported for Node.
import Outbox from "../../extensions/chrome/outbox-core.js";

const T0 = 1_760_000_000_000;

function entry(overrides: Record<string, unknown> = {}) {
  const base = Outbox.makeEntry(
    {
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      text: "hello world",
      url: "https://example.com/a",
      title: "Example",
      history: { title: "[Page] Example", url: "https://example.com/a", type: "page-capture" },
      destination: { origin: "https://axiom.example", tokenHash: "hash-a" },
    },
    T0,
  );
  return { ...base, ...overrides };
}

describe("capture outbox backoff", () => {
  it("doubles from 30s and caps at 15m", () => {
    expect(Outbox.backoffMs(1)).toBe(30_000);
    expect(Outbox.backoffMs(2)).toBe(60_000);
    expect(Outbox.backoffMs(3)).toBe(120_000);
    expect(Outbox.backoffMs(10)).toBe(15 * 60_000);
    expect(Outbox.backoffMs(50)).toBe(15 * 60_000);
  });
});

describe("capture outbox delivery classification", () => {
  it("treats network failure and 5xx as retryable", () => {
    expect(Outbox.classifyDelivery(null)).toBe("retry");
    expect(Outbox.classifyDelivery({ ok: false, status: 500 })).toBe("retry");
    expect(Outbox.classifyDelivery({ ok: false, status: 503 })).toBe("retry");
  });

  it("treats 2xx as delivered", () => {
    expect(Outbox.classifyDelivery({ ok: true, status: 201 })).toBe("delivered");
  });

  it("treats 409 as delivered only for a URL-only capture with the endpoint's exact duplicate conflict", () => {
    // The server's (workspace, source, url) unique index covers every capture
    // with a URL, so a text-bearing 409 means the content was REJECTED — the
    // server kept an earlier version. Only a URL-only duplicate is same-intent
    // and safe to drop, and only when the problem body is pinned to this
    // endpoint's duplicate-URL conflict (type + code + title), so an arbitrary
    // 409 from a proxy or another API version cannot masquerade as a duplicate.
    const urlOnly = entry({ text: "", url: "https://example.com/a" });
    const duplicate = {
      ok: false,
      status: 409,
      problemCode: "conflict",
      problemType: "https://axiom.dev/problems/conflict",
      problemTitle: "That URL is already in the inbox.",
    };
    expect(Outbox.classifyDelivery(duplicate, urlOnly)).toBe("delivered");
    expect(Outbox.classifyDelivery(duplicate, entry())).toBe("conflicted");
    expect(Outbox.classifyDelivery({ ...duplicate, problemTitle: "conflict" }, urlOnly)).toBe("conflicted");
    expect(Outbox.classifyDelivery({ ...duplicate, problemType: null }, urlOnly)).toBe("conflicted");
    expect(Outbox.classifyDelivery({ ...duplicate, problemCode: "other" }, urlOnly)).toBe("conflicted");
    expect(Outbox.classifyDelivery({ ok: false, status: 409 }, urlOnly)).toBe("conflicted");
  });

  it("treats 401/403 as needs-auth and other 4xx as permanently failed", () => {
    expect(Outbox.classifyDelivery({ ok: false, status: 401 })).toBe("needs-auth");
    expect(Outbox.classifyDelivery({ ok: false, status: 403 })).toBe("needs-auth");
    expect(Outbox.classifyDelivery({ ok: false, status: 422 })).toBe("failed");
    expect(Outbox.classifyDelivery({ ok: false, status: 400 })).toBe("failed");
  });
});

describe("capture outbox entry lifecycle", () => {
  it("a fresh entry is queued and immediately due", () => {
    const e = entry();
    expect(e.status).toBe("queued");
    expect(e.attempts).toBe(0);
    expect(Outbox.isDue(e, T0)).toBe(true);
  });

  it("a retryable failure keeps the entry queued with a future attempt", () => {
    const e = entry();
    const next = Outbox.applyOutcome(e, "retry", T0, "Polymath is unreachable.");
    expect(next.status).toBe("queued");
    expect(next.attempts).toBe(1);
    expect(next.nextAttemptAt).toBe(T0 + 30_000);
    expect(next.lastError).toBe("Polymath is unreachable.");
    expect(Outbox.isDue(next, T0)).toBe(false);
    expect(Outbox.isDue(next, T0 + 30_000)).toBe(true);
  });

  it("delivery drops the entry (returns null)", () => {
    expect(Outbox.applyOutcome(entry(), "delivered", T0, null)).toBeNull();
  });

  it("exhausted retries park the entry as failed, never dropped", () => {
    let e = entry();
    for (let i = 0; i < Outbox.MAX_ATTEMPTS; i++) {
      e = Outbox.applyOutcome(e, "retry", T0 + i * 60_000, "down");
    }
    expect(e.status).toBe("failed");
    expect(e.attempts).toBe(Outbox.MAX_ATTEMPTS);
    expect(Outbox.isDue(e, T0 + 10_000_000)).toBe(false);
  });

  it("needs-auth parks without consuming the retry budget silently", () => {
    const e = Outbox.applyOutcome(entry(), "needs-auth", T0, "401");
    expect(e.status).toBe("needs-auth");
    const again = Outbox.requeue(e, T0 + 1000);
    expect(again.status).toBe("queued");
    expect(Outbox.isDue(again, T0 + 1000)).toBe(true);
  });

  it("recovers entries stranded in sending by a worker crash", () => {
    const { entries, changed } = Outbox.recoverInFlight([entry({ status: "sending" }), entry({ id: "b", status: "failed" })]);
    expect(changed).toBe(true);
    expect(entries[0].status).toBe("queued");
    expect(entries[1].status).toBe("failed");
  });
});

describe("capture outbox quota and scheduling", () => {
  it("refuses a candidate that would cross the byte budget", () => {
    const big = entry({ text: "x".repeat(Outbox.QUOTA_BUDGET_BYTES) });
    expect(Outbox.hasQuotaFor([], big)).toBe(false);
    expect(Outbox.hasQuotaFor([], entry())).toBe(true);
  });

  it("schedules the alarm at the earliest due entry, or not at all", () => {
    const later = entry({ id: "b", nextAttemptAt: T0 + 60_000 });
    const sooner = entry({ nextAttemptAt: T0 + 30_000 });
    expect(Outbox.nextWakeAt([later, sooner], T0)).toBe(T0 + 30_000);
    expect(Outbox.nextWakeAt([entry({ status: "failed" })], T0)).toBeNull();
    expect(Outbox.nextWakeAt([], T0)).toBeNull();
  });
});

describe("capture outbox destination binding", () => {
  it("matches only the exact origin and credential hash", () => {
    const bound = { origin: "https://axiom.example", tokenHash: "hash-a" };
    expect(Outbox.destinationsMatch(bound, { origin: "https://axiom.example", tokenHash: "hash-a" })).toBe(true);
    // key rotation or an account switch changes the hash: not provably the
    // same account, so it must not auto-deliver.
    expect(Outbox.destinationsMatch(bound, { origin: "https://axiom.example", tokenHash: "hash-b" })).toBe(false);
    expect(Outbox.destinationsMatch(bound, { origin: "https://other.example", tokenHash: "hash-a" })).toBe(false);
    // an unbound entry (pre-binding build) is never a match: park, don't guess.
    expect(Outbox.destinationsMatch(null, bound)).toBe(false);
    expect(Outbox.destinationsMatch(bound, null)).toBe(false);
  });

  it("parks on identity mismatch instead of delivering to the new destination", () => {
    const parked = Outbox.applyOutcome(entry(), "identity-mismatch", T0, "changed");
    expect(parked.status).toBe("parked-identity");
    expect(parked.nextAttemptAt).toBe(0);
    expect(Outbox.isDue(parked, T0 + 999_999_999)).toBe(false);
  });

  it("rebind re-stamps the destination and queues with a fresh budget", () => {
    const parked = Outbox.applyOutcome(entry(), "identity-mismatch", T0, "changed");
    const rebound = Outbox.rebind(parked, { origin: "https://new.example", tokenHash: "hash-b" }, T0 + 1000);
    expect(rebound.status).toBe("queued");
    expect(rebound.attempts).toBe(0);
    expect(rebound.destination).toEqual({ origin: "https://new.example", tokenHash: "hash-b" });
    expect(Outbox.isDue(rebound, T0 + 1000)).toBe(true);
  });

  it("conflicted parks for the user rather than discarding the text", () => {
    const parked = Outbox.applyOutcome(entry(), "conflicted", T0, "duplicate");
    expect(parked.status).toBe("conflicted");
    expect(parked.text).toBe("hello world");
    expect(Outbox.isDue(parked, T0 + 999_999_999)).toBe(false);
  });
});
