import { executeComposioWrite } from "../composio";
import type { Transport } from "../transport";

/*
 * Canva design import (ASH-286 handoff): the provider write a design brief
 * can perform. Only the approved-effect executor calls it - no tool, no
 * gateway path, no route - and it mirrors the gmail/send.ts contract.
 *
 * Grounded contracts (canva.dev design-imports reference, fetched 2026-10-25):
 *  - create job: POST /rest/v1/imports, the file as application/octet-stream
 *    with an Import-Metadata header carrying {"title"}. Through the Composio
 *    proxy's documented `binary_body` the approved bytes ride the same
 *    approval-bound seam as a send; no second transport, no URL fetch.
 *  - the job is ASYNCHRONOUS: a created job is not an imported design. The
 *    terminal answer comes from GET /rest/v1/imports/{jobId}, which the
 *    reconciliation sweep asks. The create answer only starts the clock.
 *  - there is NO list-imports endpoint (the API exposes exactly create,
 *    create-by-url, get, get-url-job). A creation whose response was lost
 *    cannot be looked up again, so that attempt stays UNKNOWN for a human -
 *    the same honesty the calendar executor keeps - and never re-fires.
 *
 * Failure classification mirrors gmail/send.ts, grounded in the same two
 * contracts (Composio proxy reference; Canva import reference):
 *  - the proxy's own non-200 4xx is a documented pre-dispatch refusal -> rejected;
 *  - a provider 4xx inside the proxy's 200 envelope means Canva refused before
 *    creating a job -> rejected;
 *  - a timeout, any 5xx, or a success we cannot prove (no job id) proves
 *    nothing -> ambiguous. The executor maps ambiguous to UNKNOWN.
 */

const IMPORTS_ENDPOINT = "https://api.canva.com/rest/v1/imports";
const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/*
 * The fixture mode for journeys that must prove the full handoff with ZERO
 * possible real transport (e2e/dev only). Opt-in is explicit
 * (CANVA_IMPORT_PROVIDER=fixture), REFUSED in production, and there is no
 * fallthrough: a fixture call returns before any network code runs. Fixture
 * ids derive from the content hash, so they are deterministic per approved
 * payload and can never collide with a real Canva id.
 */
const FIXTURE_ENV = "CANVA_IMPORT_PROVIDER";

export class CanvaImportFixtureInProductionError extends Error {
  readonly code = "canva_import_fixture_in_production";
  constructor() {
    super("The Canva import fixture is not allowed in production.");
    this.name = "CanvaImportFixtureInProductionError";
  }
}

export function canvaImportFixtureEnabled(): boolean {
  if (process.env[FIXTURE_ENV] !== "fixture") return false;
  if (process.env.NODE_ENV === "production") throw new CanvaImportFixtureInProductionError();
  return true;
}

export class CanvaImportRejectedError extends Error {
  readonly code = "canva_import_rejected";
  constructor(readonly status: number) {
    super(`Canva rejected the import (${status}).`);
    this.name = "CanvaImportRejectedError";
  }
}

export class CanvaImportAmbiguousError extends Error {
  readonly code = "canva_import_ambiguous";
  constructor(message: string) {
    super(message);
    this.name = "CanvaImportAmbiguousError";
  }
}

function jobIdOf(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const job = (data as { job?: unknown }).job;
  if (job === null || typeof job !== "object") return null;
  const id = (job as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function createCanvaImportJob(input: {
  connectedAccountId: string;
  /** The approved design title; Canva caps it, so it is sliced, never reworded. */
  title: string;
  docx: Uint8Array;
}): Promise<{ jobId: string }> {
  if (canvaImportFixtureEnabled()) {
    // No network by construction: the fixture job id is the content hash.
    const { createHash } = await import("node:crypto");
    return { jobId: `fixture-import-${createHash("sha256").update(input.docx).digest("hex").slice(0, 12)}` };
  }
  const result = await executeComposioWrite({
    connectedAccountId: input.connectedAccountId,
    endpoint: IMPORTS_ENDPOINT,
    method: "POST",
    headers: { "Import-Metadata": JSON.stringify({ title: input.title.slice(0, 255) }) },
    binaryBody: { base64: Buffer.from(input.docx).toString("base64"), contentType: DOCX_CONTENT_TYPE },
  });

  if (!result.ok) {
    // The proxy's own documented 4xx refused the call before dispatch.
    if (result.code === "provider_error" && typeof result.status === "number" && result.status >= 400 && result.status < 500) {
      throw new CanvaImportRejectedError(result.status);
    }
    throw new CanvaImportAmbiguousError(result.message);
  }

  // The proxy's 200 envelope carries the provider's own status.
  if (typeof result.providerStatus === "number") {
    if (result.providerStatus >= 400 && result.providerStatus < 500) {
      throw new CanvaImportRejectedError(result.providerStatus);
    }
    if (result.providerStatus >= 500) {
      throw new CanvaImportAmbiguousError(`Canva returned ${result.providerStatus}; the import outcome is unproven.`);
    }
  }

  const jobId = jobIdOf(result.data);
  if (!jobId) throw new CanvaImportAmbiguousError("Canva answered without an import job id.");
  return { jobId };
}

/** The terminal states a get-job read can report, in the sweep's vocabulary. */
export type CanvaImportJobState =
  | { status: "in_progress" }
  | { status: "success"; designId: string | null; editUrl: string | null }
  | { status: "failed"; errorCode: string | null };

export type CanvaImportJobResult = { ok: true; job: CanvaImportJobState } | { ok: false; code: string; message: string };

/**
 * The sweep's one read question: "what did the job we created do?" Parsed
 * leniently - an unreadable answer is a non-answer, and a non-answer settles
 * nothing.
 */
export async function getCanvaImportJob(
  transport: Transport,
  input: { connectedAccountId: string; jobId: string },
): Promise<CanvaImportJobResult> {
  if (canvaImportFixtureEnabled()) {
    // No transport by construction: a fixture job answers terminally, so a
    // journey can prove the sweep's settle path end to end.
    return {
      ok: true,
      job: { status: "success", designId: `fixture-design-${input.jobId.replace(/^fixture-import-/, "")}`, editUrl: null },
    };
  }
  const res = await transport.read({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${IMPORTS_ENDPOINT}/${encodeURIComponent(input.jobId)}`,
    method: "GET",
  });
  if (!res.ok) return { ok: false, code: res.code, message: res.message };

  const job = (res.data as { job?: unknown } | null)?.job;
  if (job === null || typeof job !== "object") {
    return { ok: false, code: "provider_error", message: "Canva returned an unreadable import job." };
  }
  const status = (job as { status?: unknown }).status;
  if (status === "in_progress") return { ok: true, job: { status: "in_progress" } };
  if (status === "success") {
    const designs = (job as { result?: { designs?: unknown } }).result?.designs;
    const first = Array.isArray(designs) && designs.length > 0 ? designs[0] : null;
    const designId =
      first && typeof (first as { id?: unknown }).id === "string" ? ((first as { id: string }).id ?? null) : null;
    const urls = first ? (first as { urls?: { edit_url?: unknown } }).urls : null;
    const editUrl = urls && typeof urls.edit_url === "string" ? urls.edit_url : null;
    return { ok: true, job: { status: "success", designId, editUrl } };
  }
  if (status === "failed") {
    const code = (job as { error?: { code?: unknown } }).error?.code;
    return { ok: true, job: { status: "failed", errorCode: typeof code === "string" ? code : null } };
  }
  return { ok: false, code: "provider_error", message: "Canva returned an unknown import job status." };
}
