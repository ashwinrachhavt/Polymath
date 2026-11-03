import { describe, expect, it } from "vitest";
import { buildActivityItem, planOperationGroups, resolveActorRef, selectSentence } from "@/domains/audit/present";
import type { ActivityEventRow } from "@/domains/audit/queries";

/*
 * The presenter's pure core: the actor-attribution matrix, the fail-closed
 * sentence ladder, and the operation-grouping plan. No database here - the
 * orchestration (metadata load, hydration queries, per-domain entity checks)
 * is proven against real Postgres in tests/integration/audit-presenter.test.ts.
 */

const VIEWER_ID = "viewer-1";

const row = (over: Partial<ActivityEventRow> = {}): ActivityEventRow => ({
  id: crypto.randomUUID(),
  action: "capture.created",
  actorId: VIEWER_ID,
  actorKind: "user",
  subjectType: "capture",
  subjectId: crypto.randomUUID(),
  operationId: null,
  summary: "raw stored summary",
  createdAt: new Date("2026-11-03T12:00:00.000Z"),
  ...over,
});

type ItemInputOverrides = {
  userNames?: Map<string, string | null>;
  agentLabels?: Map<string, string>;
  metadataMap?: Map<string, unknown>;
  views?: Map<string, { title: string | null } | null>;
  stepRows?: ActivityEventRow[];
};

const itemInput = (over: ItemInputOverrides = {}) => ({
  viewerId: VIEWER_ID,
  userNames: over.userNames ?? new Map<string, string | null>(),
  agentLabels: over.agentLabels ?? new Map<string, string>(),
  metadataMap: over.metadataMap ?? new Map<string, unknown>(),
  views: over.views ?? new Map<string, { title: string | null } | null>(),
  stepRows: over.stepRows ?? [],
});

describe("resolveActorRef", () => {
  it("reads the viewer's own row as You", () => {
    expect(resolveActorRef(row({ actorId: VIEWER_ID }), VIEWER_ID, new Map(), new Map())).toEqual({
      label: "You",
      kind: "user",
    });
  });

  it("reads another member from the hydrated display name", () => {
    const names = new Map([["u2", "Alex Rivera"]]);
    expect(resolveActorRef(row({ actorId: "u2" }), VIEWER_ID, names, new Map())).toEqual({
      label: "Alex Rivera",
      kind: "user",
    });
  });

  it("falls back to Workspace member for a missing, null, or blank name", () => {
    const blank = new Map([["u2", "   "]]);
    expect(resolveActorRef(row({ actorId: "u2" }), VIEWER_ID, new Map(), new Map()).label).toBe("Workspace member");
    expect(resolveActorRef(row({ actorId: "u2" }), VIEWER_ID, new Map([["u2", null]]), new Map()).label).toBe(
      "Workspace member",
    );
    expect(resolveActorRef(row({ actorId: "u2" }), VIEWER_ID, blank, new Map()).label).toBe("Workspace member");
  });

  it("reads a known principal label for agent actors and Agent otherwise", () => {
    const labels = new Map([["p1", "Nightly Briefing"]]);
    expect(resolveActorRef(row({ actorKind: "agent", actorId: "p1" }), VIEWER_ID, new Map(), labels)).toEqual({
      label: "Nightly Briefing",
      kind: "agent",
    });
    expect(resolveActorRef(row({ actorKind: "agent", actorId: "gone" }), VIEWER_ID, new Map(), new Map()).label).toBe(
      "Agent",
    );
    expect(resolveActorRef(row({ actorKind: "agent", actorId: null }), VIEWER_ID, new Map(), new Map()).label).toBe(
      "Agent",
    );
  });

  it("reads system rows as Polymath regardless of any actor id", () => {
    expect(resolveActorRef(row({ actorKind: "system", actorId: null }), VIEWER_ID, new Map(), new Map())).toEqual({
      label: "Polymath",
      kind: "system",
    });
  });
});

describe("selectSentence", () => {
  it("renders the registry template when the payload is version 1", () => {
    const sentence = selectSentence(
      row({ action: "capture.converted", summary: "Capture became note: Scraped Header" }),
      { version: 1, resultType: "note", resultId: crypto.randomUUID() },
      { label: "You", kind: "user" },
    );
    expect(sentence).toBe("You converted a capture");
  });

  it("renders the stored summary verbatim for a legacy allowlisted row", () => {
    const sentence = selectSentence(row(), null, { label: "You", kind: "user" });
    expect(sentence).toBe("raw stored summary");
  });

  it("sanitizes a legacy connection failure at the established separator", () => {
    const sentence = selectSentence(
      row({
        action: "integration.connection_failed",
        summary: "Connection failed: Google as Work — Provider exploded",
      }),
      null,
      { label: "You", kind: "user" },
    );
    expect(sentence).toBe("Connection failed: Google as Work");
  });

  it("renders the generic summary for a legacy unlisted action, never the stored summary", () => {
    const sentence = selectSentence(row({ action: "task.created", summary: "should not render" }), null, {
      label: "You",
      kind: "user",
    });
    expect(sentence).toBe("Task created recorded");
  });

  it("renders the generic summary for an unknown action with no payload", () => {
    const sentence = selectSentence(row({ action: "widgets.whirr", summary: "anything" }), null, {
      label: "You",
      kind: "user",
    });
    expect(sentence).toBe("Widgets whirr recorded");
  });

  it("renders the technical default for a registered technical action with a versioned payload", () => {
    const sentence = selectSentence(row({ action: "task.created" }), { version: 1 }, { label: "You", kind: "user" });
    expect(sentence).toBe("Workspace activity recorded");
  });

  it("ignores a future payload version rather than rendering v1 assumptions", () => {
    const sentence = selectSentence(
      row({ summary: "legacy still governs" }),
      { version: 2 },
      {
        label: "You",
        kind: "user",
      },
    );
    expect(sentence).toBe("legacy still governs");
  });
});

describe("planOperationGroups", () => {
  it("folds step rows into the outcome, oldest first", () => {
    const outcome = row({
      action: "capture.converted",
      operationId: "op-1",
      createdAt: new Date("2026-11-03T12:02:00.000Z"),
    });
    const stepNewer = row({
      action: "capture.proposal_accepted",
      operationId: "op-1",
      createdAt: new Date("2026-11-03T12:03:00.000Z"),
    });
    const stepOlder = row({
      action: "capture.proposal_accepted",
      operationId: "op-1",
      createdAt: new Date("2026-11-03T12:01:00.000Z"),
    });
    const plans = planOperationGroups([stepNewer, outcome, stepOlder]);
    const plan = plans.get("op-1");
    expect(plan?.outcome.id).toBe(outcome.id);
    expect(plan?.steps.map((step) => step.id)).toEqual([stepOlder.id, stepNewer.id]);
  });

  it("collapses to nothing when the page holds no outcome row", () => {
    const step = row({ action: "capture.proposal_accepted", operationId: "op-2" });
    expect(planOperationGroups([step]).size).toBe(0);
  });
});

describe("buildActivityItem destinations", () => {
  it("verifies a subject hit and carries its live title", () => {
    const captureId = crypto.randomUUID();
    const item = buildActivityItem(
      row({ subjectId: captureId }),
      itemInput({ views: new Map([[`capture:${captureId}`, { title: "Inbox idea" }]]) }),
    );
    expect(item.primary).toEqual({ label: "Open capture", href: `/command-center/inbox?id=${captureId}` });
    expect(item.title).toBe("Inbox idea");
    expect(item.related).toEqual([]);
  });

  it("renders a checked miss as unavailable, never a dead href", () => {
    const captureId = crypto.randomUUID();
    const item = buildActivityItem(
      row({ subjectId: captureId }),
      itemInput({ views: new Map([[`capture:${captureId}`, null]]) }),
    );
    expect(item.primary).toEqual({ state: "unavailable", reason: "deleted" });
  });

  it("leaves a route-less subject unlinked instead of improvising a destination", () => {
    const item = buildActivityItem(
      row({ action: "note.created", subjectType: "artifact", subjectId: crypto.randomUUID() }),
      itemInput(),
    );
    expect(item.primary).toBeNull();
    expect(item.title).toBeNull();
  });

  it("keeps a surface-level destination that needs no entity check", () => {
    const item = buildActivityItem(
      row({ action: "integration.account_active", subjectType: "external_account", subjectId: crypto.randomUUID() }),
      itemInput(),
    );
    expect(item.primary).toEqual({ label: "Integration settings", href: "/command-center/integrations" });
  });
});

describe("buildActivityItem conversions", () => {
  const conversionRow = (subjectId: string, metadata: unknown) => {
    const converted = row({ action: "capture.converted", subjectId, summary: "Capture became note: Scraped Header" });
    return { converted, metadataMap: new Map([[converted.id, metadata]]) };
  };

  it("leads with a verified result, keeps the capture as the related chip, prefers the snapshot title", () => {
    const noteId = crypto.randomUUID();
    const captureId = crypto.randomUUID();
    const { converted, metadataMap } = conversionRow(captureId, {
      version: 1,
      resultType: "note",
      resultId: noteId,
      displaySnapshot: { title: "Converted note" },
    });
    const item = buildActivityItem(
      converted,
      itemInput({
        metadataMap,
        views: new Map([
          [`capture:${captureId}`, { title: "Inbox idea" }],
          [`note:${noteId}`, { title: "Live note title" }],
        ]),
      }),
    );
    expect(item.primary).toEqual({ label: "Open note", href: `/polymath/notes?id=${noteId}` });
    expect(item.related).toEqual([{ label: "Open capture", href: `/command-center/inbox?id=${captureId}` }]);
    expect(item.title).toBe("Converted note");
    expect(item.sentence).toBe("You converted a capture");
  });

  it("falls back to the live entity title when the payload carries no snapshot", () => {
    const noteId = crypto.randomUUID();
    const captureId = crypto.randomUUID();
    const { converted, metadataMap } = conversionRow(captureId, { version: 1, resultType: "note", resultId: noteId });
    const item = buildActivityItem(
      converted,
      itemInput({
        metadataMap,
        views: new Map([[`note:${noteId}`, { title: "Live note title" }]]),
      }),
    );
    expect(item.primary).toEqual({ label: "Open note", href: `/polymath/notes?id=${noteId}` });
    expect(item.title).toBe("Live note title");
  });

  it("renders a deleted result honestly and keeps the subject as primary", () => {
    const captureId = crypto.randomUUID();
    const missingNoteId = crypto.randomUUID();
    const { converted, metadataMap } = conversionRow(captureId, {
      version: 1,
      resultType: "note",
      resultId: missingNoteId,
    });
    const item = buildActivityItem(
      converted,
      itemInput({
        metadataMap,
        views: new Map([
          [`capture:${captureId}`, { title: "Inbox idea" }],
          [`note:${missingNoteId}`, null],
        ]),
      }),
    );
    expect(item.primary).toEqual({ label: "Open capture", href: `/command-center/inbox?id=${captureId}` });
    expect(item.related).toEqual([{ state: "unavailable", reason: "deleted" }]);
  });

  it("improvises nothing for an unknown result type and routes by subject", () => {
    const captureId = crypto.randomUUID();
    const { converted, metadataMap } = conversionRow(captureId, {
      version: 1,
      resultType: "widget",
      resultId: crypto.randomUUID(),
    });
    const item = buildActivityItem(converted, itemInput({ metadataMap }));
    expect(item.primary).toEqual({ label: "Open capture", href: `/command-center/inbox?id=${captureId}` });
    expect(item.related).toEqual([]);
  });
});

describe("buildActivityItem assembly", () => {
  it("renders folded steps as sentences with their own actors", () => {
    const outcome = row({ action: "capture.converted", operationId: "op-1" });
    const step = row({ action: "capture.proposal_accepted", operationId: "op-1", actorId: "u2" });
    const item = buildActivityItem(
      outcome,
      itemInput({
        userNames: new Map([["u2", "Alex Rivera"]]),
        metadataMap: new Map([
          [outcome.id, { version: 1 }],
          [step.id, { version: 1 }],
        ]),
        stepRows: [step],
      }),
    );
    expect(item.steps).toEqual(["Alex Rivera accepted a capture proposal"]);
  });

  it("carries the registry attention class and the technical mirror of the row", () => {
    const subjectId = crypto.randomUUID();
    const created = row({ subjectId, operationId: "op-9" });
    const item = buildActivityItem(created, itemInput());
    expect(item.attention).toBe("none");
    expect(item.category).toBe("knowledge");
    expect(item.technical).toEqual({
      action: "capture.created",
      subjectType: "capture",
      subjectId,
      operationId: "op-9",
    });
    expect(item.id).toBe(created.id);
    expect(item.occurredAt).toEqual(new Date("2026-11-03T12:00:00.000Z"));
  });

  it("never carries metadata: a versioned row with junk keys serializes clean", () => {
    const metadataMap = new Map([[row().id, { version: 1, secret: "hydrant" }]]);
    const [withRowId] = [...metadataMap.entries()];
    const item = buildActivityItem(row({ id: withRowId[0] }), itemInput({ metadataMap }));
    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain("hydrant");
    expect(serialized).not.toContain("secret");
  });
});
