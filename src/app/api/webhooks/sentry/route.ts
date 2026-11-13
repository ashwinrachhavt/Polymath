import { createHmac, timingSafeEqual } from "node:crypto";
import { sentryWebhookBody, signalFromSentry } from "@/domains/bug-triage/signal";
import { recordBugSignal } from "@/domains/bug-triage/store";
import { problemResponse } from "@/lib/problems";

/*
 * POST /api/webhooks/sentry - Sentry's integration-platform webhook. Off (404)
 * unless SENTRY_WEBHOOK_SECRET (the internal integration's client secret) is
 * set. The signature is an HMAC-SHA256 of the raw body; a replayed delivery
 * only bumps the sighting count of an existing fingerprint.
 *
 * Only `event_alert` and `error` deliveries carry a stack trace; every other
 * resource (installation, issue, comment, ...) is acknowledged and ignored.
 * Recording is all this route does: the outbox worker files the issue.
 */

const MAX_BODY_BYTES = 1_000_000;
const RESOURCES_WITH_EVENTS = new Set(["event_alert", "error"]);

function signatureMatches(rawBody: string, presented: string | null, secret: string): boolean {
  if (!presented) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"));
  const actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function POST(request: Request) {
  const secret = process.env.SENTRY_WEBHOOK_SECRET;
  if (!secret) return problemResponse(404, "not_found", "Not found.");

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return problemResponse(413, "payload_too_large", "Payload too large.");
  if (!signatureMatches(rawBody, request.headers.get("sentry-hook-signature"), secret)) {
    return problemResponse(401, "unauthorized", "Unauthorized.");
  }

  const resource = request.headers.get("sentry-hook-resource") ?? "";
  if (!RESOURCES_WITH_EVENTS.has(resource)) return new Response(null, { status: 204 });

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return problemResponse(400, "invalid_body", "Body is not JSON.");
  }
  const parsed = sentryWebhookBody.safeParse(json);
  const signal = parsed.success ? signalFromSentry(parsed.data) : null;
  if (!signal) return problemResponse(422, "invalid_body", "No Sentry event in the body.");

  await recordBugSignal(signal);
  return new Response(null, { status: 202 });
}
