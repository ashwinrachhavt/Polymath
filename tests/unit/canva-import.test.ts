import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CanvaImportAmbiguousError,
  CanvaImportRejectedError,
  createCanvaImportJob,
  getCanvaImportJob,
} from "@/domains/integrations/canva/import";
import type { Transport } from "@/domains/integrations/transport";

/*
 * The Canva import module's two contracts, pinned against a stubbed fetch:
 *  1. the proxy envelope carries the approved bytes as binary_body plus the
 *     Import-Metadata header - the exact shape the documented v3 proxy
 *     contract names;
 *  2. failure classification mirrors gmail's: a proxy or provider 4xx is a
 *     pre-creation refusal (rejected), while a timeout, a 5xx, or an
 *     unprovable success is ambiguous and must never read as failure.
 */

const API_KEY = "test-composio-key";
beforeAll(() => {
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.CANVA_IMPORT_ENABLED = "true";
});
afterAll(() => {
  delete process.env.COMPOSIO_API_KEY;
  delete process.env.CANVA_IMPORT_ENABLED;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return respond();
    }),
  );
  return calls;
}

const DOCX = new TextEncoder().encode("fake docx bytes");
const input = { connectedAccountId: "ca_test", title: "Design brief: Launch one-pager", docx: DOCX };

describe("createCanvaImportJob envelope", () => {
  it("sends the documented binary_body shape and the Import-Metadata header", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ data: { job: { id: "job_1" }, status: "success" } }), { status: 200 }));
    const result = await createCanvaImportJob(input);
    expect(result).toEqual({ jobId: "job_1" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://backend.composio.dev/api/v3/tools/execute/proxy");
    const envelope = JSON.parse(String(calls[0]!.init.body));
    expect(envelope.connected_account_id).toBe("ca_test");
    expect(envelope.endpoint).toBe("https://api.canva.com/rest/v1/imports");
    expect(envelope.method).toBe("POST");
    expect(envelope.binary_body).toEqual({
      base64: Buffer.from(DOCX).toString("base64"),
      content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(Buffer.from(envelope.binary_body.base64, "base64").equals(Buffer.from(DOCX))).toBe(true);
    expect(envelope.parameters).toContainEqual({
      name: "Import-Metadata",
      value: JSON.stringify({ title: "Design brief: Launch one-pager" }),
      type: "header",
    });
  });

  it("slices an over-long title instead of rewording it", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ data: { job: { id: "job_1" } } }), { status: 200 }));
    await createCanvaImportJob({ ...input, title: "x".repeat(400) });
    const envelope = JSON.parse(String(calls[0]!.init.body));
    const meta = envelope.parameters.find((p: { name: string }) => p.name === "Import-Metadata");
    expect(JSON.parse(meta.value).title).toHaveLength(255);
  });
});

describe("createCanvaImportJob classification", () => {
  it("proxy 4xx is a pre-dispatch refusal", async () => {
    stubFetch(() => new Response("bad request", { status: 400 }));
    await expect(createCanvaImportJob(input)).rejects.toBeInstanceOf(CanvaImportRejectedError);
  });

  it("proxy 429 (documented pre-dispatch rate refusal) is rejected, not ambiguous", async () => {
    stubFetch(() => new Response("rate limited", { status: 429 }));
    await expect(createCanvaImportJob(input)).rejects.toBeInstanceOf(CanvaImportRejectedError);
  });

  it("a provider 4xx inside the 200 envelope is a refusal before job creation", async () => {
    stubFetch(() => new Response(JSON.stringify({ status: 400, data: { error: "invalid" } }), { status: 200 }));
    await expect(createCanvaImportJob(input)).rejects.toBeInstanceOf(CanvaImportRejectedError);
  });

  it("a provider 5xx inside the envelope proves nothing", async () => {
    stubFetch(() => new Response(JSON.stringify({ status: 500, data: {} }), { status: 200 }));
    await expect(createCanvaImportJob(input)).rejects.toBeInstanceOf(CanvaImportAmbiguousError);
  });

  it("a proxy 5xx proves nothing", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    await expect(createCanvaImportJob(input)).rejects.toBeInstanceOf(CanvaImportAmbiguousError);
  });

  it("a dead socket (timeout/abort) is ambiguous, never a failure", async () => {
    stubFetch(() => Promise.reject(new Error("The operation timed out.")));
    await expect(createCanvaImportJob(input)).rejects.toBeInstanceOf(CanvaImportAmbiguousError);
  });

  it("a success without a job id is unproven", async () => {
    stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await expect(createCanvaImportJob(input)).rejects.toBeInstanceOf(CanvaImportAmbiguousError);
  });
});

function transportReturning(data: unknown): Transport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async read(request) {
      calls.push(request.endpoint);
      return { ok: true, status: 200, data };
    },
  };
}

describe("getCanvaImportJob", () => {
  it("asks the job endpoint by id", async () => {
    const transport = transportReturning({ job: { id: "job_9", status: "in_progress" } });
    const result = await getCanvaImportJob(transport, { connectedAccountId: "ca_test", jobId: "job_9" });
    expect(transport.calls).toEqual(["https://api.canva.com/rest/v1/imports/job_9"]);
    expect(result).toEqual({ ok: true, job: { status: "in_progress" } });
  });

  it("reads a terminal success with the design id and edit url", async () => {
    const transport = transportReturning({
      job: {
        id: "job_9",
        status: "success",
        result: { designs: [{ id: "DAF123", urls: { edit_url: "https://www.canva.com/design/DAF123/edit" } }] },
      },
    });
    const result = await getCanvaImportJob(transport, { connectedAccountId: "ca_test", jobId: "job_9" });
    expect(result).toEqual({
      ok: true,
      job: { status: "success", designId: "DAF123", editUrl: "https://www.canva.com/design/DAF123/edit" },
    });
  });

  it("reads a terminal failure with Canva's error code", async () => {
    const transport = transportReturning({ job: { id: "job_9", status: "failed", error: { code: "invalid_file", message: "nope" } } });
    const result = await getCanvaImportJob(transport, { connectedAccountId: "ca_test", jobId: "job_9" });
    expect(result).toEqual({ ok: true, job: { status: "failed", errorCode: "invalid_file" } });
  });

  it("an unreadable answer is a non-answer, not a settle", async () => {
    const transport = transportReturning({ unexpected: true });
    const result = await getCanvaImportJob(transport, { connectedAccountId: "ca_test", jobId: "job_9" });
    expect(result.ok).toBe(false);
  });

  it("a transport error is a non-answer", async () => {
    const transport: Transport = {
      async read() {
        return { ok: false, code: "provider_error", status: 503, message: "down" };
      },
    };
    const result = await getCanvaImportJob(transport, { connectedAccountId: "ca_test", jobId: "job_9" });
    expect(result.ok).toBe(false);
  });
});

describe("the live-enablement boundary", () => {
  it("a configured Composio key alone does not enable a create: refusal, zero provider calls", async () => {
    delete process.env.CANVA_IMPORT_ENABLED;
    const calls = stubFetch(() => new Response(JSON.stringify({ data: { job: { id: "job_1" } } }), { status: 200 }));
    try {
      await expect(createCanvaImportJob(input)).rejects.toThrow(/Canva import is not enabled/);
    } finally {
      process.env.CANVA_IMPORT_ENABLED = "true";
    }
    expect(calls).toHaveLength(0);
  });

  it("a configured Composio key alone does not enable a poll: non-answer, zero provider calls", async () => {
    delete process.env.CANVA_IMPORT_ENABLED;
    let reads = 0;
    const transport: Transport = {
      async read() {
        reads += 1;
        return { ok: true, status: 200, data: { job: { status: "success" } } };
      },
    };
    try {
      const result = await getCanvaImportJob(transport, { connectedAccountId: "ca_test", jobId: "job_1" });
      expect(result).toMatchObject({ ok: false, code: "canva_import_disabled" });
    } finally {
      process.env.CANVA_IMPORT_ENABLED = "true";
    }
    expect(reads).toBe(0);
  });
});
