"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { archiveArea, declareArea, updateArea } from "@/domains/knowledge/areas";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

const uuid = z.string().uuid();
const revalidate = () => revalidatePath("/polymath/knowledge/areas");

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

export async function declareAreaAction(input: unknown) {
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(80),
      tags: z.array(z.string().trim().min(1).max(40)).max(12),
      idempotencyKey: uuid.optional(),
    })
    .parse(input);
  const auth = await authorize();
  const area = await declareArea(auth, parsed);
  revalidate();
  return area;
}

export async function updateAreaAction(input: unknown) {
  const parsed = z
    .object({
      areaId: uuid,
      expectedVersion: z.number().int().positive(),
      name: z.string().trim().min(1).max(80).optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
      idempotencyKey: uuid.optional(),
    })
    .parse(input);
  const auth = await authorize();
  const area = await updateArea(auth, parsed);
  revalidate();
  return area;
}

export async function archiveAreaAction(input: unknown) {
  const parsed = z
    .object({ areaId: uuid, expectedVersion: z.number().int().positive(), idempotencyKey: uuid.optional() })
    .parse(input);
  const auth = await authorize();
  const area = await archiveArea(auth, parsed);
  revalidate();
  return area;
}
