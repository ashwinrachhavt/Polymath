"use server";

import { z } from "zod";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { DiagramError, appendCanvasScene } from "@/domains/diagrams/diagrams";
import { canvasSceneSizeError } from "@/domains/diagrams/types";
import type { MessageResult } from "@/lib/result";

/*
 * Saving a canvas checkpoint from the canonical canvas editor: the drawing
 * appends a new canvas_versions row (append-only — the generated Mermaid
 * history is never rewritten), and a renamed title moves with it.
 */

const input = z.object({
  canvasId: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  scene: z.object({
    elements: z.array(z.unknown()),
    appState: z.record(z.string(), z.unknown()).optional(),
    files: z.record(z.string(), z.unknown()).optional(),
  }),
});

export async function saveCanvasScene(raw: unknown): Promise<MessageResult<{ versionNumber: number }>> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "That canvas checkpoint could not be read. Try saving again." };

  const oversize = canvasSceneSizeError(parsed.data.scene);
  if (oversize) return { ok: false, message: `This drawing is too large to checkpoint: ${oversize}` };

  const auth = await getAuthContext();
  requireRole(auth, "member");
  try {
    const result = await appendCanvasScene(auth, {
      canvasId: parsed.data.canvasId,
      scene: parsed.data.scene,
      title: parsed.data.title,
    });
    return { ok: true, versionNumber: result.versionNumber };
  } catch (error) {
    if (error instanceof DiagramError) return { ok: false, message: "This canvas is not available." };
    throw error;
  }
}
