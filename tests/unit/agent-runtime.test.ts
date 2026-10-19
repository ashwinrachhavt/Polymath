import { describe, expect, it } from "vitest";
import {
  RUNTIME_CONTRACT_VERSION,
  capabilityGrant,
  runtimeStartRequest,
} from "@/domains/agents/runtime/contracts";
import { FakeAgentRuntime } from "@/domains/agents/runtime/fake";
import { makeStartRequest, runFakeRuntimeContract } from "@/domains/agents/runtime/contract-suite";

/*
 * RT02 (ASH-116): the contracts are validated at the boundary, and the fake
 * passes the shared behavioral suite every future adapter must pass.
 */

runFakeRuntimeContract();

describe("runtime contracts: validation", () => {
  it("rejects a start request with a bad generation, expiry or dispatch key", () => {
    const good = makeStartRequest();
    expect(() =>
      runtimeStartRequest.parse({ ...good, identity: { ...good.identity, executionGeneration: 0 } }),
    ).toThrow();
    expect(() =>
      runtimeStartRequest.parse({ ...good, dispatchKey: "" }),
    ).toThrow();
    expect(() =>
      capabilityGrant.parse({ ...good.grant, expiresAt: "soon" }),
    ).toThrow();
    expect(good.identity.contractVersion).toBe(RUNTIME_CONTRACT_VERSION);
  });

  it("provider fog makes inspection unknown, never confirmed-absent", async () => {
    const fake = new FakeAgentRuntime();
    const req = makeStartRequest();
    await fake.start(req);
    fake.setProviderFog(true);
    const seen = await fake.inspect(req.identity);
    expect(seen.kind).toBe("unknown");
  });
});
