import { z } from "zod";
import type { Transport } from "@/domains/integrations/transport";
import type { ReadFailure } from "./github";

/*
 * Instagram reads over the Instagram Login surface (graph.instagram.com):
 * the professional account's profile and its recent media. Both need a
 * Business or Creator account - a personal account answers with a provider
 * error the owner can act on, not a silent empty list. Captions and media
 * metadata are untrusted provider content.
 */

const API = "https://graph.instagram.com";

const profileSchema = z.object({
  id: z.string(),
  username: z.string().optional(),
  account_type: z.string().optional(),
  media_count: z.number().optional(),
});

const mediaItemSchema = z.object({
  id: z.string(),
  caption: z.string().optional(),
  media_type: z.string().optional(),
  permalink: z.string().optional(),
  timestamp: z.string().optional(),
});

const mediaSchema = z.object({
  data: z.array(mediaItemSchema.passthrough()).optional(),
  paging: z.object({ next: z.string().optional() }).optional(),
});

function malformed(what: string): ReadFailure {
  return { ok: false, code: "malformed_response", message: `Instagram returned a ${what} response this app does not recognise.` };
}

export type InstagramProfile = {
  id: string;
  username: string | null;
  accountType: string | null;
  mediaCount: number | null;
};

export type InstagramMediaItem = {
  id: string;
  caption: string | null;
  mediaType: string | null;
  permalink: string | null;
  timestamp: string | null;
};

export async function getInstagramProfile(
  transport: Transport,
  input: { connectedAccountId: string },
): Promise<{ ok: true; profile: InstagramProfile } | ReadFailure> {
  const result = await transport.read({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${API}/me`,
    method: "GET",
    query: { fields: "id,username,account_type,media_count" },
  });
  if (!result.ok) {
    return result.code === "not_configured"
      ? { ok: false, code: "not_configured", message: "This deployment cannot reach Instagram yet." }
      : { ok: false, code: "provider_error", message: result.message };
  }
  const parsed = profileSchema.safeParse(result.data);
  if (!parsed.success) return malformed("profile");
  return {
    ok: true,
    profile: {
      id: parsed.data.id,
      username: parsed.data.username ?? null,
      accountType: parsed.data.account_type ?? null,
      mediaCount: parsed.data.media_count ?? null,
    },
  };
}

export async function listInstagramMedia(
  transport: Transport,
  input: { connectedAccountId: string; limit: number },
): Promise<{ ok: true; items: InstagramMediaItem[] } | ReadFailure> {
  const result = await transport.read({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${API}/me/media`,
    method: "GET",
    query: { fields: "id,caption,media_type,permalink,timestamp", limit: String(input.limit) },
  });
  if (!result.ok) {
    return result.code === "not_configured"
      ? { ok: false, code: "not_configured", message: "This deployment cannot reach Instagram yet." }
      : { ok: false, code: "provider_error", message: result.message };
  }
  const parsed = mediaSchema.safeParse(result.data);
  if (!parsed.success) return malformed("media");
  const items = (parsed.data.data ?? []).map((item) => ({
    id: item.id,
    caption: item.caption ? (item.caption.length > 280 ? `${item.caption.slice(0, 280)}…` : item.caption) : null,
    mediaType: item.media_type ?? null,
    permalink: item.permalink ?? null,
    timestamp: item.timestamp ?? null,
  }));
  return { ok: true, items };
}
