import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/file-validation";
import { randomId } from "@/lib/random-id";

/*
 * The one client-side upload path into the inbox: POST /api/v1/captures/file,
 * the same multipart route the command layer, chat composer, and conversation
 * starter already drive. Surfaces without a hook into one of those components
 * call this instead of growing another copy of the fetch-and-map block. The
 * server sniffs content and assigns the kind; the client's job is only to
 * deliver the bytes and surface the outcome honestly.
 */

export type CaptureUploadResult =
  { ok: true; captureId: string; quarantined: boolean } | { ok: false; message: string };

export async function uploadCaptureFile(file: File): Promise<CaptureUploadResult> {
  // Matches the API route's deploy-supported cap; the message shows BEFORE submit.
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, message: `Captures are limited to ${MAX_UPLOAD_LABEL} - the largest upload this app accepts.` };
  }
  const form = new FormData();
  form.set("file", file);
  try {
    const res = await fetch("/api/v1/captures/file", {
      method: "POST",
      headers: { "idempotency-key": randomId() },
      body: form,
    });
    if (!res.ok) {
      // A platform-level 413 answers with an HTML error page, not a problem
      // body - name the limit either way, and never auto-retry.
      if (res.status === 413) return { ok: false, message: `That file is over the ${MAX_UPLOAD_LABEL} limit.` };
      const problem = (await res.json().catch(() => null)) as { title?: string } | null;
      return { ok: false, message: problem?.title ?? "Could not capture the file. Try again." };
    }
    const created = (await res.json()) as { captureId: string; quarantined?: boolean };
    return { ok: true, captureId: created.captureId, quarantined: created.quarantined === true };
  } catch {
    return { ok: false, message: "Could not capture the file. Try again." };
  }
}

/** The first pasted or dropped file from a clipboard/drag event, if any. */
export function eventFile(data: { files?: FileList | File[] } | null | undefined): File | null {
  return Array.from(data?.files ?? [])[0] ?? null;
}
