"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import {
  importStatement,
  StatementExtractionMissingError,
} from "@/domains/knowledge/statement-import";

/*
 * Reading a ledger out of a statement. Parsing is deterministic and local, so
 * the action is cheap to repeat — but it is still a write, so it requires
 * member and re-validates the document's workspace through importStatement.
 */

const uuid = z.string().uuid();

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

export async function readStatementLedger(documentId: string): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const parsed = uuid.safeParse(documentId);
  if (!parsed.success) return { ok: false, error: "That document id is not valid." };
  const auth = await authorize();
  try {
    const result = await importStatement(auth, parsed.data);
    revalidatePath("/alfred/knowledge");
    return { ok: true, status: result.import.status };
  } catch (cause) {
    if (cause instanceof StatementExtractionMissingError) {
      return { ok: false, error: "Read the document first, then build its ledger." };
    }
    throw cause;
  }
}
