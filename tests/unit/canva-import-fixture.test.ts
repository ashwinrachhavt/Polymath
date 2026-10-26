import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CanvaImportFixtureInProductionError,
  canvaImportFixtureEnabled,
  createCanvaImportJob,
  getCanvaImportJob,
} from "@/domains/integrations/canva/import";
import type { Transport } from "@/domains/integrations/transport";

/*
 * The fixture mode's safety contract, pinned: explicit opt-in only, refused
 * in production, and no fallthrough - a fixture call provably never touches
 * the network or a transport.
 */

const DOCX = new TextEncoder().encode("fake docx bytes");

afterEach(() => {
  delete process.env.CANVA_IMPORT_PROVIDER;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("canva import fixture mode", () => {
  it("is off by default", () => {
    expect(canvaImportFixtureEnabled()).toBe(false);
  });

  it("is refused in production even when opted in", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.CANVA_IMPORT_PROVIDER = "fixture";
    expect(() => canvaImportFixtureEnabled()).toThrow(CanvaImportFixtureInProductionError);
  });

  it("job creation returns a deterministic content-bound id with zero network", async () => {
    process.env.CANVA_IMPORT_PROVIDER = "fixture";
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const a = await createCanvaImportJob({ connectedAccountId: "ca_any", title: "T", docx: DOCX });
    const b = await createCanvaImportJob({ connectedAccountId: "ca_any", title: "T", docx: DOCX });
    expect(a.jobId).toMatch(/^fixture-import-[0-9a-f]{12}$/);
    expect(a.jobId).toBe(b.jobId);
    expect(spy).not.toHaveBeenCalled();
  });

  it("the fixture job answers terminally without a transport read", async () => {
    process.env.CANVA_IMPORT_PROVIDER = "fixture";
    const transport: Transport = {
      async read() {
        throw new Error("transport must not be called in fixture mode");
      },
    };
    const created = await createCanvaImportJob({ connectedAccountId: "ca_any", title: "T", docx: DOCX });
    const result = await getCanvaImportJob(transport, { connectedAccountId: "ca_any", jobId: created.jobId });
    expect(result).toEqual({
      ok: true,
      job: { status: "success", designId: created.jobId.replace("fixture-import-", "fixture-design-"), editUrl: null },
    });
  });
});
