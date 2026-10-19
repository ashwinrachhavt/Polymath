import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/internal/outbox/route";

describe("POST /api/internal/outbox", () => {
  afterEach(() => {
    delete process.env.OUTBOX_DISPATCH_SECRET;
  });

  it("is off (404) when no secret is configured", async () => {
    const res = await POST(new Request("http://x/api/internal/outbox", { method: "POST" }));
    expect(res.status).toBe(404);
  });

  it("rejects a missing or wrong bearer", async () => {
    process.env.OUTBOX_DISPATCH_SECRET = "s3cret-value";
    const none = await POST(new Request("http://x/api/internal/outbox", { method: "POST" }));
    expect(none.status).toBe(401);
    const wrong = await POST(
      new Request("http://x/api/internal/outbox", { method: "POST", headers: { authorization: "Bearer nope" } }),
    );
    expect(wrong.status).toBe(401);
  });
});
