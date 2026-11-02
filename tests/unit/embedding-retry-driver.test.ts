import { describe, expect, it } from "vitest";
import {
  EMBEDDING_RETRY_TOPIC,
  embeddingRetryDispatchKey,
  parseEmbeddingRetryPayload,
} from "@/domains/knowledge/embedding";
import { clampSweepLimit, EMBEDDING_RETRY_SWEEP_MAX } from "@/domains/knowledge/embedding-retry";

/*
 * Pure surface of the embedding retry driver. The database-backed behavior
 * (seed → sweep → dispatch → heal, model guard, batch bounds on real rows)
 * lives in tests/integration/embedding-retry-driver.test.ts.
 */

describe("embedding retry sweep bounds", () => {
  it("the default pass takes a bounded slice, not the whole table", () => {
    expect(clampSweepLimit()).toBe(50);
  });

  it("a caller's limit is clamped into [1, 200] - a zero or negative limit still makes progress", () => {
    expect(clampSweepLimit(0)).toBe(1);
    expect(clampSweepLimit(-5)).toBe(1);
    expect(clampSweepLimit(1)).toBe(1);
  });

  it("a limit above the ceiling is capped so one sweep cannot flood the queue", () => {
    expect(clampSweepLimit(250)).toBe(EMBEDDING_RETRY_SWEEP_MAX);
    expect(EMBEDDING_RETRY_SWEEP_MAX).toBe(200);
  });

  it("a fractional limit truncates instead of selecting a fraction of a row", () => {
    expect(clampSweepLimit(2.7)).toBe(2);
  });

  it("a NaN limit falls back to the default instead of poisoning the SQL LIMIT", () => {
    expect(clampSweepLimit(Number.NaN)).toBe(50);
  });
});

describe("embedding retry dispatch key", () => {
  it("one live order per owner, version, and model", () => {
    const key = embeddingRetryDispatchKey(
      "artifact",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "fake@1",
    );
    expect(key).toBe(
      "embedding.retry:artifact:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:fake@1",
    );
  });

  it("a null version token still occupies its slot, so it cannot collide with a real version's key", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(embeddingRetryDispatchKey("artifact", id, null, "fake@1")).toBe(
      `embedding.retry:artifact:${id}:none:fake@1`,
    );
  });

  it("a different model is a different key, so a model switch re-drives instead of deduping away", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(embeddingRetryDispatchKey("document_extraction", id, id, "fake@1")).not.toBe(
      embeddingRetryDispatchKey("document_extraction", id, id, "fake@2"),
    );
  });

  it("the topic is a stable contract between producer and handler registry", () => {
    expect(EMBEDDING_RETRY_TOPIC).toBe("embedding.retry_requested");
  });
});

describe("embedding retry payload parser", () => {
  it("accepts the exact shapes the producer writes", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseEmbeddingRetryPayload({ ownerType: "artifact", ownerId: id })).toEqual({
      ownerType: "artifact",
      ownerId: id,
    });
    expect(parseEmbeddingRetryPayload({ ownerType: "document_extraction", ownerId: id })).toEqual({
      ownerType: "document_extraction",
      ownerId: id,
    });
  });

  it("rejects a payload the producer never wrote, so the attempt fails loudly", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseEmbeddingRetryPayload(null)).toBeNull();
    expect(parseEmbeddingRetryPayload(undefined)).toBeNull();
    expect(parseEmbeddingRetryPayload("artifact")).toBeNull();
    expect(parseEmbeddingRetryPayload({})).toBeNull();
    // "note" was the payload's ownerType in the original handoff and was
    // never a coverage unit: unknown kinds must not become silent no-ops.
    expect(parseEmbeddingRetryPayload({ ownerType: "note", ownerId: id })).toBeNull();
    expect(parseEmbeddingRetryPayload({ ownerType: "artifact" })).toBeNull();
  });

  it("rejects a non-uuid id, which would otherwise surface as a Postgres cast error", () => {
    expect(parseEmbeddingRetryPayload({ ownerType: "artifact", ownerId: "not-a-uuid" })).toBeNull();
    expect(parseEmbeddingRetryPayload({ ownerType: "artifact", ownerId: 42 })).toBeNull();
  });
});
