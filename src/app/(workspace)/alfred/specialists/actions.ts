"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createCustomSpecialist, installSpecialist } from "@/domains/agents/specialists";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * The specialists page's mutation surface. Installing and creating are writes,
 * so member-or-above; the domain functions are idempotent on (workspace, name),
 * so a double-submit returns the existing profile instead of a second row.
 */

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const revalidate = () => revalidatePath("/alfred/specialists");

export async function installSpecialistAction(input: { slug: string }) {
  const auth = await authorize();
  const parsed = z.object({ slug: z.string().min(1).max(80) }).parse(input);
  const result = await installSpecialist(auth, parsed);
  revalidate();
  return result;
}

export async function createCustomSpecialistAction(input: {
  name: string;
  mission: string;
  instructions: string;
  allowedTools: string[];
}) {
  const auth = await authorize();
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(60),
      mission: z.string().trim().max(300).default(""),
      instructions: z.string().trim().min(1).max(8000),
      allowedTools: z
        .array(z.enum(["tasks.read", "documents.search", "web.search", "web.fetch", "gmail.send"]))
        .max(10)
        .default(["tasks.read", "documents.search", "web.search", "web.fetch"]),
    })
    .parse(input);
  const result = await createCustomSpecialist(auth, parsed);
  revalidate();
  return result;
}
