import { z } from "zod";
import type { Transport } from "@/domains/integrations/transport";
import type { ReadFailure } from "./github";

/*
 * Slack reads over a `Transport`. Slack's Web API answers HTTP 200 with
 * `{ ok: false, error }` for most failures, so the body is checked: a failed
 * call that looked like an empty channel would be read as "nothing was said".
 */

const API = "https://slack.com/api";

// Slack ids: uppercase letters and digits (C, G, D, U prefixes).
export const slackId = z.string().regex(/^[A-Z0-9]{2,32}$/, "Use a Slack channel id such as C0123456789.");

const envelope = z.object({ ok: z.boolean(), error: z.string().optional() }).passthrough();

const channelsSchema = z.object({
  channels: z
    .array(z.object({ id: z.string(), name: z.string().optional(), is_private: z.boolean().optional(), is_archived: z.boolean().optional(), num_members: z.number().optional(), topic: z.object({ value: z.string() }).optional() }))
    .optional(),
});

const historySchema = z.object({
  messages: z
    .array(z.object({ ts: z.string(), user: z.string().optional(), bot_id: z.string().optional(), text: z.string().optional(), thread_ts: z.string().optional(), reply_count: z.number().optional() }))
    .optional(),
  has_more: z.boolean().optional(),
});

function checked(data: unknown): { ok: true; data: unknown } | ReadFailure {
  const parsed = envelope.safeParse(data);
  if (!parsed.success) {
    return { ok: false, code: "malformed_response", message: "Slack returned a response this app does not recognise." };
  }
  if (!parsed.data.ok) {
    const error = parsed.data.error ?? "unknown_error";
    return { ok: false, code: "provider_error", message: `Slack refused the read (${error}).` };
  }
  return { ok: true, data };
}

export async function listSlackChannels(
  transport: Transport,
  input: { connectedAccountId: string; limit: number },
): Promise<{ ok: true; channels: Array<{ id: string; name: string | null; private: boolean; members: number | null; topic: string | null }> } | ReadFailure> {
  const response = await transport.read({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${API}/conversations.list`,
    method: "GET",
    query: { limit: String(input.limit), exclude_archived: "true", types: "public_channel,private_channel" },
  });
  if (!response.ok) return { ok: false, code: response.code, message: response.message };
  const body = checked(response.data);
  if (!body.ok) return body;
  const parsed = channelsSchema.safeParse(body.data);
  if (!parsed.success) return { ok: false, code: "malformed_response", message: "Slack returned a channel list this app does not recognise." };
  return {
    ok: true,
    channels: (parsed.data.channels ?? []).filter((c) => !c.is_archived).map((c) => ({
      id: c.id,
      name: c.name ?? null,
      private: c.is_private ?? false,
      members: c.num_members ?? null,
      topic: c.topic?.value || null,
    })),
  };
}

export async function readSlackChannel(
  transport: Transport,
  input: { connectedAccountId: string; channel: string; limit: number },
): Promise<{ ok: true; messages: Array<{ ts: string; at: string; author: string | null; text: string | null; replies: number | null }>; hasMore: boolean } | ReadFailure> {
  const response = await transport.read({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${API}/conversations.history`,
    method: "GET",
    query: { channel: input.channel, limit: String(input.limit) },
  });
  if (!response.ok) return { ok: false, code: response.code, message: response.message };
  const body = checked(response.data);
  if (!body.ok) return body;
  const parsed = historySchema.safeParse(body.data);
  if (!parsed.success) return { ok: false, code: "malformed_response", message: "Slack returned a history this app does not recognise." };
  return {
    ok: true,
    hasMore: parsed.data.has_more ?? false,
    messages: (parsed.data.messages ?? []).map((m) => ({
      ts: m.ts,
      at: new Date(Number(m.ts) * 1000).toISOString(),
      author: m.user ?? m.bot_id ?? null,
      text: m.text ?? null,
      replies: m.reply_count ?? null,
    })),
  };
}
