import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { documents, documentObligations } from "@/domains/knowledge/schema";
import { users, workspaces } from "@/domains/identity/schema";
import { makeTestDb } from "../helpers/test-workspace";
import { taskLinks, tasks } from "@/domains/work/schema";

/*
 * The obligation-acceptance invariants a mock would only pretend to hold: the
 * accept transaction's all-or-nothing shape, its idempotency against a second
 * accept, and supersede leaving the accepted task alone. Skipped without a
 * scratch database, same as document-schema.test.ts.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

let db: NonNullable<typeof handle>["db"];
let obligations: typeof import("@/domains/knowledge/obligations");

afterAll(async () => {
  await handle?.client.end();
});

suite("document obligations", () => {
  let workspaceId: string;
  let userId: string;
  let documentId: string;
  const auth = () => ({ userId, workspaceId, role: "owner" as const });

  beforeAll(async () => {
    if (!handle) return;
    db = handle.db;
    obligations = await import("@/domains/knowledge/obligations");
    const [user] = await db.insert(users).values({ clerkUserId: `clerk_obligations_${Date.now()}` }).returning();
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: "obligations", slug: `obligations-${Date.now()}`, createdBy: user.id })
      .returning();
    const [doc] = await db
      .insert(documents)
      .values({ workspaceId: workspace.id, title: "Acme invoice" })
      .returning();
    userId = user.id;
    workspaceId = workspace.id;
    documentId = doc.id;
  });

  it("accept creates exactly one task, one taskLink, one audit row", async () => {
    const obligation = await obligations.proposeObligation(auth(), {
      documentId,
      kind: "confirm_invoice_status",
      note: "Confirm whether the Acme invoice was paid",
      dedupeKey: "confirm_invoice_status:doc",
    });
    expect(obligation).not.toBeNull();

    const { taskId } = await obligations.acceptObligation(auth(), {
      obligationId: obligation!.id,
      dueAt: new Date("2026-11-01"),
    });

    const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].title).toBe("Confirm whether the Acme invoice was paid");
    expect(taskRows[0].dueAt).toEqual(new Date("2026-11-01"));

    const links = await db.select().from(taskLinks).where(eq(taskLinks.taskId, taskId));
    expect(links).toHaveLength(1);
    expect(links[0].targetType).toBe("document");
    expect(links[0].targetId).toBe(documentId);

    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectId, obligation!.id), eq(auditEvents.action, "obligation.accepted")));
    expect(audits).toHaveLength(1);

    const [stored] = await db
      .select()
      .from(documentObligations)
      .where(eq(documentObligations.id, obligation!.id));
    expect(stored.status).toBe("accepted");
    expect(stored.taskId).toBe(taskId);
  });

  it("a second accept of the decided obligation is rejected and creates no second task", async () => {
    const obligation = await obligations.proposeObligation(auth(), {
      documentId,
      kind: "provide_missing_info",
      dedupeKey: "provide_missing_info:doc",
    });
    const first = await obligations.acceptObligation(auth(), { obligationId: obligation!.id });

    await expect(
      obligations.acceptObligation(auth(), { obligationId: obligation!.id }),
    ).rejects.toThrow(/already decided/);

    const links = await db.select().from(taskLinks).where(eq(taskLinks.taskId, first.taskId));
    expect(links).toHaveLength(1);
  });

  it("superseding leaves the accepted task untouched", async () => {
    const old = await obligations.proposeObligation(auth(), {
      documentId,
      kind: "review_agreement",
      dedupeKey: "review_agreement:doc",
    });
    const { taskId } = await obligations.acceptObligation(auth(), { obligationId: old!.id });

    const replacement = await obligations.proposeObligation(auth(), {
      documentId,
      kind: "review_agreement",
      note: "Amended agreement",
      dedupeKey: "review_agreement:doc:v2",
    });
    const superseded = await obligations.supersedeObligation(auth(), {
      obligationId: old!.id,
      supersededById: replacement!.id,
    });
    expect(superseded.status).toBe("superseded");
    expect(superseded.supersededBy).toBe(replacement!.id);

    // The human may still need to do the work; a document change does not
    // cancel their task.
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task.status).toBe("inbox");
    expect(task.cancelledAt).toBeNull();
  });

  it("a proposal re-play on the same dedupe key inserts nothing", async () => {
    const values = {
      documentId,
      kind: "confirm_invoice_status",
      dedupeKey: "confirm_invoice_status:doc",
    };
    const replay = await obligations.proposeObligation(auth(), values);
    expect(replay).toBeNull();

    const rows = await db
      .select()
      .from(documentObligations)
      .where(eq(documentObligations.dedupeKey, values.dedupeKey));
    expect(rows).toHaveLength(1);
  });
});
