"use server";

import { revalidatePath } from "next/cache";
import { convertCaptureToTask, createCapture, setCaptureState } from "@/domains/capture/commands";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/* Inbox actions (A02). Every write carries the version the caller rendered. */

type Result = { ok: true } | { ok: false; error: string };

const revalidate = () => revalidatePath("/command-center/inbox");

async function authorize() {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

function fail(error: unknown): Result {
  return { ok: false, error: error instanceof Error ? error.message : "The inbox write failed." };
}

export async function captureTextAction(input: { text: string }): Promise<Result> {
  const auth = await authorize();
  try {
    await createCapture(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function makeTaskAction(input: { captureId: string; expectedVersion: number }): Promise<Result> {
  const auth = await authorize();
  try {
    await convertCaptureToTask(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function setCaptureStateAction(input: {
  captureId: string;
  expectedVersion: number;
  state: "discarded" | "unprocessed";
}): Promise<Result> {
  const auth = await authorize();
  try {
    await setCaptureState(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}
