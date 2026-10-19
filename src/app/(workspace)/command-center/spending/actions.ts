"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  ConflictError,
  createRateCard,
  StaleWriteError,
  upsertSpendingPolicy,
} from "@/domains/spending/policy";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Spending mutations. Money arrives as a string and stays a string all the
 * way into the numeric column - no float ever touches a dollar. An empty
 * ceiling field means "no ceiling", not zero: zero would block every run.
 */

const revalidate = () => revalidatePath("/command-center/spending");

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

type Result = { ok: true } | { ok: false; error: string };

function fail(error: unknown): Result {
  if (error instanceof StaleWriteError || error instanceof ConflictError) {
    return { ok: false, error: error.message };
  }
  throw error;
}

const money = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,6})?$/, "A nonnegative dollar amount, at most six decimal places.");

const optionalMoney = z
  .string()
  .trim()
  .refine((value) => value === "" || /^\d{1,9}(\.\d{1,4})?$/.test(value), {
    message: "A nonnegative dollar amount, at most four decimal places - or leave it empty for no ceiling.",
  });

export async function savePolicyAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({
      dailyCeilingUsd: optionalMoney,
      monthlyCeilingUsd: optionalMoney,
      perRunCeilingUsd: optionalMoney,
      onExceeded: z.enum(["pause", "fail"]),
      expectedVersion: z.number().int().min(1).nullable(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the amounts and try again." };
  }
  const auth = await authorize();
  try {
    await upsertSpendingPolicy(auth, {
      dailyCeilingUsd: parsed.data.dailyCeilingUsd || null,
      monthlyCeilingUsd: parsed.data.monthlyCeilingUsd || null,
      perRunCeilingUsd: parsed.data.perRunCeilingUsd || null,
      onExceeded: parsed.data.onExceeded,
      expectedVersion: parsed.data.expectedVersion,
    });
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function createRateCardAction(input: unknown): Promise<Result> {
  const parsed = z
    .object({
      provider: z.string().trim().min(1).max(100),
      model: z.string().trim().min(1).max(200),
      inputPerMillion: money,
      outputPerMillion: money,
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the rates and try again." };
  }
  const auth = await authorize();
  try {
    await createRateCard(auth, parsed.data);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}
