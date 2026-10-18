import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { documents, documentExtractions, fieldProposals } from "@/domains/knowledge/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Field proposals against real Postgres: the (documentId, dedupeKey) unique
 * index must make proposeFields idempotent — a replay of the same extraction
 * finds its twin and writes nothing new. Skipped without TEST_DATABASE_URL,
 * same as the other suites.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const holder: {
  db: NonNullable<ReturnType<typeof makeTestDb>>["db"];
  auth: { userId: string; workspaceId: string; role: "owner" } | undefined;
} = {
  db: undefined as never,
  auth: undefined,
};

vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

import { proposeFields } from "@/domains/knowledge/fields";

beforeAll(() => {
  if (!handle) return;
  holder.db = handle.db;
});

afterAll(async () => {
  await handle?.client.end();
});

suite("field proposals", () => {
  it("is idempotent on retry: same rows, no duplicates", async () => {
    const db = holder.db!;
    const { userId, workspaceId } = await seedWorkspace(db, `fields-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };

    const [document] = await db
      .insert(documents)
      .values({ workspaceId, title: "Acme invoice" })
      .returning();
    const [extraction] = await db
      .insert(documentExtractions)
      .values({ workspaceId, documentId: document.id, contentHash: `hash-${crypto.randomUUID()}` })
      .returning();

    const fields = [
      {
        fieldKind: "date" as const,
        fieldName: "invoice_date",
        rawValue: "03/04/2026",
        evidenceSpans: [{ page: 1, start: 0, end: 10 }],
      },
      {
        fieldKind: "money" as const,
        fieldName: "total",
        rawValue: "$1,200.00",
        evidenceSpans: [{ page: 1, start: 20, end: 29 }],
      },
    ];

    const first = await proposeFields(holder.auth!, {
      documentId: document.id,
      extractionId: extraction.id,
      fields,
    });
    expect(first.proposed).toBe(2);

    const replay = await proposeFields(holder.auth!, {
      documentId: document.id,
      extractionId: extraction.id,
      fields,
    });
    expect(replay.proposed).toBe(0);
    expect(replay.skipped).toBe(2);

    const rows = await db
      .select()
      .from(fieldProposals)
      .where(eq(fieldProposals.documentId, document.id));
    expect(rows).toHaveLength(2);

    // The ambiguous date is preserved as proposed, never guessed.
    const date = rows.find((r) => r.fieldKind === "date");
    expect(date?.rawValue).toBe("03/04/2026");
    expect(date?.normalizedValue).toBeNull();
    expect(date?.normalizationNote).toBe("date format ambiguous (dd/mm vs mm/dd)");

    // Raw machine output is verbatim; normalization lives beside it.
    const money = rows.find((r) => r.fieldKind === "money");
    expect(money?.rawValue).toBe("$1,200.00");
    expect(money?.normalizedValue).toEqual({ amount: 1200.0, currency: "USD" });
  });

  it("does not see another workspace's proposals", async () => {
    const db = holder.db!;
    const { userId, workspaceId } = await seedWorkspace(db, `fields-b-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };

    const [document] = await db
      .insert(documents)
      .values({ workspaceId, title: "Other tenant" })
      .returning();
    const [extraction] = await db
      .insert(documentExtractions)
      .values({ workspaceId, documentId: document.id, contentHash: `hash-${crypto.randomUUID()}` })
      .returning();

    await proposeFields(holder.auth!, {
      documentId: document.id,
      extractionId: extraction.id,
      fields: [
        {
          fieldKind: "identifier" as const,
          fieldName: "invoice_number",
          rawValue: "INV-001",
          evidenceSpans: [],
        },
      ],
    });

    const ours = await db
      .select()
      .from(fieldProposals)
      .where(
        and(eq(fieldProposals.workspaceId, workspaceId), eq(fieldProposals.fieldName, "invoice_number")),
      );
    expect(ours).toHaveLength(1);
  });
});
