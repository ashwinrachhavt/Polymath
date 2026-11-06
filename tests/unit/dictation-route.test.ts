// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * POST /api/v1/dictation — the dictation transport (issue #532).
 *
 * protects: the composer mic's only server path: the env-selected provider
 *   streams SSE frames back, the fixture flow works end to end without a key,
 *   unconfigured dictation is a 503 with the reason, and a deepgram selection
 *   without DEEPGRAM_API_KEY is a loud 500 - never a silent fallback.
 * fails_when: the route buffers instead of streaming, swallows the provider
 *   gate (a paid provider could activate unnoticed), or answers 200 with no
 *   provider configured.
 * seam: the route module with the auth shell mocked at the boundary; the
 *   fixture provider is the real one from the seam.
 */

vi.mock("@/lib/auth", () => ({
  authedHandler:
    (handler: (auth: unknown, request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request, ctx: unknown) =>
      handler({ userId: "u1", workspaceId: "w1", role: "owner" }, request, ctx),
}));

import { POST } from "@/app/api/v1/dictation/route";
import { parseSseFrames } from "@/lib/speech/client-dictation";

function audioRequest(): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      setTimeout(() => controller.close(), 30);
    },
  });
  return new Request("http://localhost/api/v1/dictation", {
    method: "POST",
    body,
    // @ts-expect-error Node accepts duplex for streaming bodies; the DOM type lags.
    duplex: "half",
  });
}

async function readSse(response: Response) {
  const text = await response.text();
  return parseSseFrames(text).frames;
}

describe("POST /api/v1/dictation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is a loud 503 when no streaming provider is configured", async () => {
    vi.stubEnv("TRANSCRIPTION_STREAMING_PROVIDER", "");
    const response = await POST(audioRequest(), undefined as never);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/TRANSCRIPTION_STREAMING_PROVIDER/);
  });

  it("is a loud 500 when deepgram is selected without its key", async () => {
    vi.stubEnv("TRANSCRIPTION_STREAMING_PROVIDER", "deepgram");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    const response = await POST(audioRequest(), undefined as never);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/DEEPGRAM_API_KEY/);
  });

  it("streams the fixture's interim -> final frames as SSE and ends with the trailing flush", async () => {
    vi.stubEnv("TRANSCRIPTION_STREAMING_PROVIDER", "fixture");
    const response = await POST(audioRequest(), undefined as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const frames = await readSse(response);
    const kinds = frames.map((f) => f.kind);
    expect(kinds[0]).toBe("interim");
    expect(kinds).toContain("final");
    const last = frames[frames.length - 1];
    expect(last.kind === "final" && last.trailing).toBe(true);
    const finalTexts = frames.filter((f) => f.kind === "final").map((f) => f.text);
    expect(finalTexts).toContain("Fixture dictation:");
    expect(finalTexts).toContain("review the launch notes");
  });
});
