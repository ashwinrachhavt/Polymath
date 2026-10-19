"use server";

import { revalidatePath } from "next/cache";
import { registerAccount, setAccountStatus, setDefaultForWrites } from "@/domains/integrations/commands";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Connector actions (D09 foundation). These manage Axiom's bookkeeping rows
 * only. The OAuth handshake itself is scaffolding for now: registering an
 * account opens a `connecting` row, and the Composio hosted-auth redirect +
 * callback that would flip it to `active` lands with the provider work. No
 * provider is called and nothing is written externally from here.
 */

type Result = { ok: true } | { ok: false; error: string };

const revalidate = () => revalidatePath("/command-center/integrations");

async function authorize() {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

function fail(error: unknown): Result {
  return { ok: false, error: error instanceof Error ? error.message : "The connector write failed." };
}

export async function registerAccountAction(input: { provider: string; alias: string }): Promise<Result> {
  const auth = await authorize();
  if (!input.alias.trim()) return { ok: false, error: "An alias is required - models choose accounts by alias." };
  try {
    await registerAccount(auth, { provider: input.provider, alias: input.alias.trim() });
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function setAccountStatusAction(input: {
  accountId: string;
  expectedVersion: number;
  status: "active" | "revoked" | "error";
}): Promise<Result> {
  const auth = await authorize();
  try {
    await setAccountStatus(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function setWriteDefaultAction(input: { accountId: string; expectedVersion: number }): Promise<Result> {
  const auth = await authorize();
  try {
    await setDefaultForWrites(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}
