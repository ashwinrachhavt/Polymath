import { describe, expect, it } from "vitest";
import { initialStreamState, reduceStreamEvent } from "@/components/polymath/zettels/creation-stream-reducer";
import type { SittingEvent } from "@/domains/knowledge/sitting-events";

const RUN = "3f6b0b6a-7a5a-4a5a-9a5a-6a5a4a3a2a1a";
const OTHER_RUN = "9f6b0b6a-7a5a-4a5a-9a5a-6a5a4a3a2a1a";
const ART = "1b6b0b6a-7a5a-4a5a-9a5a-6a5a4a3a2a1a";
const V1 = "2b6b0b6a-7a5a-4a5a-9a5a-6a5a4a3a2a1a";
const V2 = "4b6b0b6a-7a5a-4a5a-9a5a-6a5a4a3a2a1a";

const ev = (event: SittingEvent["event"], payload?: unknown, ids?: Partial<SittingEvent>): SittingEvent => ({
  protocolVersion: 1, operationId: RUN, artifactId: ART, event, payload, ...ids,
});

describe("creation stream reducer (§11 guards)", () => {
  it("adopts the first run id and ignores a late stream from another run (sitting switch)", () => {
    let s = initialStreamState("sitting-1");
    s = reduceStreamEvent(s, ev("card_saved", { outcome: "saved", versionNumber: 3 }, { artifactVersionId: V1 }));
    expect(s.operationId).toBe(RUN);
    expect(s.savedVersionNumber).toBe(3);
    const before = s;
    s = reduceStreamEvent(s, { ...ev("token", { content: "STALE" }), operationId: OTHER_RUN });
    expect(s).toBe(before);
  });

  it("appends live tokens bound to the run's version; drops tokens for another version", () => {
    let s = initialStreamState("sitting-1");
    s = reduceStreamEvent(s, ev("card_saved", {}, { artifactVersionId: V1 }));
    s = reduceStreamEvent(s, ev("thinking", { content: "Reading…" }));
    s = reduceStreamEvent(s, ev("token", { content: "hel" }));
    s = reduceStreamEvent(s, ev("token", { content: "lo" }));
    expect(s.live.tokens).toBe("hello");
    const before = s;
    s = reduceStreamEvent(s, ev("token", { content: "WRONG-VERSION" }, { artifactVersionId: V2 }));
    expect(s).toBe(before);
  });

  it("fails one stage without touching its siblings (§14.4)", () => {
    let s = initialStreamState("sitting-1");
    s = reduceStreamEvent(s, ev("stage_started", { stage: "embed" }));
    s = reduceStreamEvent(s, ev("stage_completed", { stage: "embed", outcome: "embedded:v2" }));
    s = reduceStreamEvent(s, ev("stage_failed", { stage: "links", code: "QUOTA_UNAVAILABLE", message: "Link discovery needs AI quota — your card is saved.", operationId: RUN }));
    expect(s.stages.embed).toEqual({ status: "done", outcome: "embedded:v2" });
    expect(s.stages.links?.status).toBe("failed");
    expect(s.stages.links?.failure?.code).toBe("QUOTA_UNAVAILABLE");
  });

  it("turns enrichment into a version-bound proposal and finishes on done", () => {
    let s = initialStreamState("sitting-1");
    s = reduceStreamEvent(s, ev("card_saved", {}, { artifactVersionId: V1 }));
    s = reduceStreamEvent(s, ev("token", { content: "streamed" }));
    s = reduceStreamEvent(s, ev("enrichment", { outcome: "enriched", suggestion: "committed" }));
    expect(s.proposal?.suggestion).toBe("committed");
    expect(s.proposal?.artifactVersionId).toBe(V1);
    s = reduceStreamEvent(s, ev("done"));
    expect(s.done).toBe(true);
  });
});
