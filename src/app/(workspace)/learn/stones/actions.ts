"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { buyStone, StonePurchaseError } from "@/domains/stones/coins";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

const slugSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

export type BuyStoneResult = { ok: true; balance: number; alreadyOwned: boolean } | { ok: false; error: string };

/** Buys one stone for the signed-in person. The price is the catalog's, never the client's. */
export async function buyStoneAction(slug: string): Promise<BuyStoneResult> {
  const parsed = slugSchema.safeParse(slug);
  if (!parsed.success) return { ok: false, error: "There is no such stone." };
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    const purchase = await buyStone(auth, parsed.data);
    revalidatePath("/learn/stones");
    revalidatePath("/learn");
    return { ok: true, balance: purchase.balance, alreadyOwned: purchase.alreadyOwned };
  } catch (error) {
    if (error instanceof StonePurchaseError) return { ok: false, error: error.message };
    return { ok: false, error: actionError(error, "Could not buy this stone.") };
  }
}
