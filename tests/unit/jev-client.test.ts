import { describe, expect, it } from "vitest";
import {
  DEFAULT_JEV_MODEL,
  httpJevClient,
  JEV_ENDPOINT,
  JevRequestError,
  JevUnconfiguredError,
} from "@/integrations/jev/client";
import fixture from "../fixtures/jev/capture-triage-response.json";

/*
 * The client contract, pinned against a recorded sanitized fixture
 * (tests/fixtures/jev/): request shape hits /v1/systemone with the pinned
 * model and bundled questions; the response's answers and usage parse as
 * documented at https://docs.typesafe.ai/api/system-one (2026-10-25). No
 * live call anywhere in the suite.
 */

describe("httpJevClient", () => {
  it("throws JevUnconfiguredError without a key", () => {
    expect(() => httpJevClient({})).toThrow(JevUnconfiguredError);
  });

  it("posts the bundled request and parses the recorded response", async () => {
    let seen: { url: string; body: { model: string; state: string; questions: unknown } } | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify(fixture.response), { status: 200 });
    };
    const client = httpJevClient({ TYPESAFE_API_KEY: "test-key" }, fetchImpl);
    const out = await client.systemOne({ state: fixture.request.state, questions: fixture.request.questions as never });

    expect(seen!.url).toBe(JEV_ENDPOINT);
    expect(seen!.body.model).toBe(DEFAULT_JEV_MODEL);
    expect(out.model).toBe("jev-1.14.0");
    expect(out.answers.commitment).toEqual({ type: "noul", noul: 0.9 });
    const domain = out.answers.domain;
    expect(domain.type).toBe("choice");
    if (domain.type === "choice") {
      expect(domain.choice).toBe("finance");
      expect(domain.probabilities.finance).toBe(0.84);
    }
    expect(out.usage.input_tokens).toBe(812);
  });

  it("JEV_MODEL overrides the pinned default", async () => {
    let seenModel = "";
    const fetchImpl: typeof fetch = async (_url, init) => {
      seenModel = JSON.parse(String(init?.body)).model;
      return new Response(JSON.stringify(fixture.response), { status: 200 });
    };
    const client = httpJevClient({ TYPESAFE_API_KEY: "k", JEV_MODEL: "jev-1.13.0" }, fetchImpl);
    await client.systemOne({ state: "s", questions: {} });
    expect(seenModel).toBe("jev-1.13.0");
  });

  it("a non-200 is a JevRequestError with status only", async () => {
    const fetchImpl: typeof fetch = async () => new Response("account detail here", { status: 429 });
    const client = httpJevClient({ TYPESAFE_API_KEY: "k" }, fetchImpl);
    await expect(client.systemOne({ state: "s", questions: {} })).rejects.toThrow(JevRequestError);
    await expect(client.systemOne({ state: "s", questions: {} })).rejects.not.toThrow(/account detail/);
  });
});
